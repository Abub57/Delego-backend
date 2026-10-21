/**
 * Balance tracking — Issue #108.
 *
 * Maps Horizon account balances into `AssetBalance` / `Trustline` models,
 * including liquidity pool shares, and provides a real-time tracker that
 * polls subscribed accounts and broadcasts balance changes over the wallet
 * WebSocket channel.
 */
import { Horizon } from "@stellar/stellar-sdk";
import type {
  AssetBalance,
  Asset as AssetModel,
  Trustline,
} from "@delegolabs/types";
import { createLogger } from "@delegolabs/utils";
import { getStellarConfig, readAssetServiceConfig } from "./config.js";
import {
  horizonBalanceToReference,
  toStroops,
  assetKey,
  type HorizonBalance,
} from "./utils.js";
import { discoverAsset, type DiscoveryDeps } from "./discovery.js";
import { getRedisConnection } from "../queue/txQueue.js";
import { broadcastBalanceEvent, getSubscriberCount } from "../websocket/server.js";
import { createHorizonServer } from "../../stellar/mockHorizon.js";

const log = createLogger("wallet:assets:balances", process.env.LOG_LEVEL ?? "info");

export interface BalancesDeps {
  server?: Horizon.Server;
  discovery?: DiscoveryDeps;
}

export interface AccountAssetsResult {
  address: string;
  nativeBalance: string;
  balances: AssetBalance[];
  trustlines: Trustline[];
  lastUpdated: string;
}

function emptyFlags() {
  return { authRequired: false, authRevocable: false, authImmutable: false };
}

function nativeAssetModel(): AssetModel {
  return {
    code: "XLM",
    issuer: "",
    type: "native",
    metadata: {
      name: "Stellar Lumens",
      symbol: "XLM",
      decimals: 7,
      logo: "https://assets.stellar.org/ingredients/lumens.svg",
    },
    flags: emptyFlags(),
  };
}

function lpAssetModel(poolId: string): AssetModel {
  const shortId = poolId.length > 12 ? `${poolId.slice(0, 6)}…${poolId.slice(-6)}` : poolId;
  return {
    code: "LP",
    issuer: poolId,
    type: "liquidity_pool",
    metadata: {
      name: `Liquidity Pool ${shortId}`,
      symbol: `LP-${shortId}`,
      decimals: 7,
      description: "Liquidity pool share represented on the account.",
    },
    flags: emptyFlags(),
  };
}

function balanceLineToStroops(b: HorizonBalance): {
  balance: string;
  available: string;
  locked: string;
} {
  const balance = toStroops(b.balance);
  const buying = toStroops(b.buying_liabilities ?? "0");
  const selling = toStroops(b.selling_liabilities ?? "0");

  const totalLocked = (BigInt(buying) + BigInt(selling)).toString();
  const available = (BigInt(balance) - BigInt(buying) - BigInt(selling)).toString();

  return { balance, available: available < "0" ? "0" : available, locked: totalLocked };
}

/**
 * Load a Horizon account and build asset balances plus trustlines.
 * Spam detection metadata (SEP-1 presence) is resolved lazily by the
 * consumer; this function returns the raw descriptors.
 */
export async function getAccountBalances(
  address: string,
  deps: BalancesDeps = {},
): Promise<AccountAssetsResult> {
  const config = getStellarConfig();
  const server = deps.server ?? createHorizonServer(config.horizonUrl);
  const account = await server.loadAccount(address);

  const rawBalances = (account.balances ?? []) as HorizonBalance[];
  const now = new Date().toISOString();

  const nativeBalanceLine = rawBalances.find((b) => b.asset_type === "native");
  const nativeBalance = nativeBalanceLine
    ? toStroops(nativeBalanceLine.balance)
    : "0";

  const balances: AssetBalance[] = [];
  const trustlines: Trustline[] = [];

  for (const line of rawBalances) {
    if (line.asset_type === "native") continue;

    const amounts = balanceLineToStroops(line);

    let asset: AssetModel;
    if (line.asset_type === "liquidity_pool_shares") {
      asset = lpAssetModel(line.liquidity_pool_id ?? "UNKNOWN");
      balances.push({
        asset,
        balance: amounts.balance,
        available: amounts.available,
        locked: amounts.locked,
        lastUpdated: now,
      });
      continue;
    }

    const ref = horizonBalanceToReference(line);
    asset = await discoverAsset(ref, deps.discovery);

    const entry: AssetBalance = {
      asset,
      balance: amounts.balance,
      available: amounts.available,
      locked: amounts.locked,
      lastUpdated: now,
    };

    // Full trustline detail for credit assets.
    if (ref.type === "credit_alphanum4" || ref.type === "credit_alphanum12") {
      const trustline: Trustline = {
        account: address,
        asset,
        limit: line.limit ? toStroops(line.limit) : "0",
        balance: amounts.balance,
        authorized: line.is_authorized ?? false,
        authorizedToMaintainLiabilities: line.is_authorized_to_maintain_liabilities ?? false,
        clawbackEnabled: line.clawback_enabled ?? false,
      };
      entry.trustline = trustline;
      trustlines.push(trustline);
    }

    balances.push(entry);
  }

  // Native balance is always first.
  balances.unshift({
    asset: nativeAssetModel(),
    balance: nativeBalance,
    available: nativeBalance,
    locked: "0",
    lastUpdated: now,
  });

  return {
    address,
    nativeBalance,
    balances,
    trustlines,
    lastUpdated: now,
  };
}

// ─── Real-time balance tracking ───────────────────────────────────────────

const POLL_STATE_PREFIX = "assets:balances:snap:";
const memorySnapshots = new Map<string, string>();

async function loadBalanceMap(address: string, deps: BalancesDeps): Promise<Record<string, string>> {
  const result = await getAccountBalances(address, deps);
  const map: Record<string, string> = {};
  for (const b of result.balances) {
    map[assetKey(b.asset)] = b.balance;
  }
  return map;
}

async function readSnapshot(address: string): Promise<Record<string, string> | null> {
  try {
    const redis = getRedisConnection();
    const raw = await redis.get(`${POLL_STATE_PREFIX}${address}`);
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    const raw = memorySnapshots.get(address);
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  }
}

async function writeSnapshot(address: string, map: Record<string, string>): Promise<void> {
  const raw = JSON.stringify(map);
  try {
    const redis = getRedisConnection();
    await redis.set(`${POLL_STATE_PREFIX}${address}`, raw, "EX", 3600);
  } catch {
    memorySnapshots.set(address, raw);
  }
}

/**
 * BalanceTracker polls subscribed accounts on an interval and broadcasts
 * a `balances_updated` WebSocket event whenever a balance changes.
 */
export class BalanceTracker {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private deps: BalancesDeps;

  constructor(deps: BalancesDeps = {}) {
    this.deps = deps;
  }

  /** Start tracking an address. Safe to call multiple times. */
  start(address: string): void {
    if (this.timers.has(address)) return;

    const interval =
      readAssetServiceConfig().balancePollIntervalSeconds * 1000;

    const poll = async (): Promise<void> => {
      try {
        await this.pollOnce(address);
      } catch (err) {
        log.warn("Balance poll failed", {
          address,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // Initial poll immediately, then on interval while subscribers exist.
    void poll();
    const timer = setInterval(() => void poll(), interval);
    this.timers.set(address, timer);
  }

  /** Stop tracking an address. */
  stop(address: string): void {
    const timer = this.timers.get(address);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(address);
    }
  }

  stopAll(): void {
    for (const address of [...this.timers.keys()]) this.stop(address);
  }

  get activeAddresses(): string[] {
    return [...this.timers.keys()];
  }

  /**
   * Poll once and broadcast on changes. Exposed for tests.
   */
  async pollOnce(address: string): Promise<string[]> {
    const map = await loadBalanceMap(address, this.deps);
    const previous = await readSnapshot(address);

    const changed: string[] = [];
    if (previous) {
      const allKeys = new Set([...Object.keys(map), ...Object.keys(previous)]);
      for (const key of allKeys) {
        if ((map[key] ?? "0") !== (previous[key] ?? "0")) changed.push(key);
      }
    } else {
      changed.push(...Object.keys(map));
    }

    await writeSnapshot(address, map);

    if (changed.length > 0) {
      const subscribers = getSubscriberCount(address);
      log.info("Balance changed, broadcasting", { address, changed, subscribers });
      try {
        broadcastBalanceEvent(address, {
          type: "balances_updated",
          address,
          balances: map,
          changedAssets: changed,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.warn("Failed to broadcast balance event", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return changed;
  }
}

export const balanceTracker = new BalanceTracker();