/**
 * Asset discovery — Issue #108.
 *
 * Discovers full `Asset` descriptors for a given code/issuer reference:
 * type normalization, issuer flags (auth_required / auth_revocable /
 * auth_immutable) from Horizon, Soroban contract id for Stellar Asset
 * Contracts, and SEP-1 metadata. Also exposes the curated default catalog
 * used before any account-level lookup.
 */
import { Asset, Horizon } from "@stellar/stellar-sdk";
import type {
  Asset as AssetModel,
  AssetFlags,
  AssetReference,
} from "@delegolabs/types";
import { createLogger } from "@delegolabs/utils";
import { getStellarConfig } from "./config.js";
import {
  assetKey,
  isNativeCode,
  NATIVE_CODE,
  toAssetType,
} from "./utils.js";
import {
  getAssetMetadata,
  nativeMetadata,
  type MetadataResolverDeps,
} from "./metadata.js";
import { getRedisConnection } from "../queue/txQueue.js";
import { createHorizonServer } from "../../stellar/mockHorizon.js";

const log = createLogger("wallet:assets:discovery", process.env.LOG_LEVEL ?? "info");

const FLAGS_CACHE_TTL_SECONDS = 24 * 60 * 60;
const memoryFlagsCache = new Map<string, { value: AssetFlags; expiresAt: number }>();

export interface DiscoveryDeps {
  server?: Horizon.Server;
  metadata?: MetadataResolverDeps;
}

export interface CuratedAsset {
  code: string;
  issuer: string;
}

/** Known, curated assets promoted in discovery (native + major anchor assets). */
export const DEFAULT_CATALOG: CuratedAsset[] = [
  { code: "XLM", issuer: "" },
  {
    code: "USDC",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
  {
    code: "BTC",
    issuer: "GDPJALI4AZKUU2W426U5WKMAT6CN3AJRPIIRYR2YM54TL2GDWO5O2MZM",
  },
  {
    code: "ETH",
    issuer: "GBFXOHVAS43OIWNIO7XLRJAHT3BICFEIKOJLZVXNT572MISM4CMGSOCC",
  },
];

function emptyFlags(): AssetFlags {
  return { authRequired: false, authRevocable: false, authImmutable: false };
}

/** Read cached issuer flags (Redis first, in-memory as a fallback). */
export async function getAssetFlags(
  code: string,
  issuer: string,
  deps: DiscoveryDeps = {},
): Promise<AssetFlags> {
  if (isNativeCode(code) || !issuer) return emptyFlags();

  const key = `assets:flags:${assetKey({
    code,
    issuer,
    type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
  })}`;

  try {
    const redis = getRedisConnection();
    const raw = await redis.get(key);
    if (raw) return JSON.parse(raw) as AssetFlags;
  } catch {
    const hit = memoryFlagsCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }

  const config = getStellarConfig();
  const server = deps.server ?? createHorizonServer(config.horizonUrl);
  let flags: AssetFlags = emptyFlags();

  try {
    const response = await server
      .assets()
      .forCode(code)
      .forIssuer(issuer)
      .limit(1)
      .call();
    const record = response.records[0] as unknown as {
      flags?: { auth_required?: boolean; auth_revocable?: boolean; auth_immutable?: boolean };
    } | undefined;
    if (record?.flags) {
      flags = {
        authRequired: record.flags.auth_required ?? false,
        authRevocable: record.flags.auth_revocable ?? false,
        authImmutable: record.flags.auth_immutable ?? false,
      };
    }
  } catch (err) {
    log.warn("Failed to resolve issuer flags", {
      code,
      issuer,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const redis = getRedisConnection();
    await redis.set(key, JSON.stringify(flags), "EX", FLAGS_CACHE_TTL_SECONDS);
  } catch {
    memoryFlagsCache.set(key, { value: flags, expiresAt: Date.now() + FLAGS_CACHE_TTL_SECONDS * 1000 });
  }

  return flags;
}

/**
 * Discover the full descriptor for one asset reference (metadata + flags +
 * Soroban contract id). Fast path for native: returns immediately with
 * curated metadata and no flags.
 */
export async function discoverAsset(
  reference: AssetReference,
  deps: DiscoveryDeps = {},
): Promise<AssetModel> {
  if (isNativeCode(reference.code)) {
    return {
      code: NATIVE_CODE,
      issuer: "",
      type: "native",
      metadata: nativeMetadata(),
      flags: emptyFlags(),
    };
  }

  const type =
    reference.type ??
    (reference.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12");

  const config = getStellarConfig();
  let contractId: string | undefined;
  if (type !== "liquidity_pool") {
    try {
      contractId = new Asset(reference.code, reference.issuer).contractId(
        config.networkPassphrase,
      );
    } catch (err) {
      log.debug("Failed to compute SAC contract id", {
        code: reference.code,
        issuer: reference.issuer,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const [metadata, flags] = await Promise.all([
    getAssetMetadata(reference.code, reference.issuer, deps.metadata),
    getAssetFlags(reference.code, reference.issuer, deps),
  ]);

  const asset: AssetModel = {
    code: reference.code,
    issuer: reference.issuer,
    type: toAssetType(type),
    metadata,
    flags,
  };
  if (contractId) asset.contractId = contractId;
  return asset;
}

/** Resolve the curated default catalog into full asset descriptors. */
export async function getCuratedAssets(
  deps: DiscoveryDeps = {},
): Promise<AssetModel[]> {
  return Promise.all(
    DEFAULT_CATALOG.map((entry) =>
      discoverAsset(
        { code: entry.code, issuer: entry.issuer, type: "credit_alphanum4" },
        deps,
      ),
    ),
  );
}