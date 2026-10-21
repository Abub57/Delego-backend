/**
 * Asset metadata resolution (SEP-1) — Issue #108.
 *
 * Resolves token metadata (name, symbol, decimals, logo, description,
 * website) for Stellar credit assets from the issuer's `.well-known/
 * stellar.toml` document per SEP-1, falling back to sensible defaults when
 * no TOML is published. Resolution results are cached in Redis (with an
 * in-memory safety net) to keep API latency low.
 */
import { Horizon, StellarToml } from "@stellar/stellar-sdk";
import { createLogger } from "@delegolabs/utils";
import type { AssetMetadata } from "@delegolabs/types";
import { readAssetServiceConfig } from "./config.js";
import { assetKey, isNativeCode } from "./utils.js";
import { getRedisConnection } from "../queue/txQueue.js";
import { createHorizonServer, getHorizonUrl } from "../../stellar/mockHorizon.js";

const log = createLogger("wallet:assets:metadata", process.env.LOG_LEVEL ?? "info");

export interface MetadataResolverDeps {
  server?: Horizon.Server;
  /** Override network access for tests. */
  resolveToml?: (domain: string) => Promise<StellarToml.Api.StellarToml>;
}

const memoryCache = new Map<string, { value: AssetMetadata; expiresAt: number }>();

export function nativeMetadata(): AssetMetadata {
  return {
    name: "Stellar Lumens",
    symbol: "XLM",
    decimals: 7,
    logo: "https://assets.stellar.org/ingredients/lumens.svg",
    description: "The native asset of the Stellar network.",
    website: "https://www.stellar.org",
  };
}

function fallbackMetadata(code: string): AssetMetadata {
  return {
    name: code,
    symbol: code,
    decimals: 7,
  };
}

/** Read the issuer home domain from Horizon's account record. */
export async function getIssuerHomeDomain(
  issuer: string,
  deps: MetadataResolverDeps = {},
): Promise<string | null> {
  const { horizonUrl } = getHorizonUrl();
  const server = deps.server ?? createHorizonServer(horizonUrl);
  try {
    const account = await server.accounts().accountId(issuer).call();
    const homeDomain = (account as unknown as { home_domain?: string }).home_domain;
    return homeDomain && homeDomain.trim() !== "" ? homeDomain.trim() : null;
  } catch (err) {
    log.warn("Failed to resolve issuer home domain", {
      issuer,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function getHorizonUrl(): { horizonUrl: string } {
  const { horizonUrl } = getStellarConfig();
  return { horizonUrl };
}

function toMetadata(
  currency: StellarToml.Api.Currency,
  orgUrl?: string,
): AssetMetadata {
  const metadata: AssetMetadata = {
    name: currency.name ?? currency.code ?? "Unknown",
    symbol: currency.code ?? currency.name ?? "UNKNOWN",
    decimals: currency.display_decimals ?? 7,
  };
  if (currency.image) metadata.logo = currency.image;
  if (currency.desc) metadata.description = currency.desc;
  if (orgUrl) metadata.website = orgUrl;
  return metadata;
}

/** Extract cached value from the shared Redis cache (tolerant of Redis failure). */
async function cacheGet(key: string): Promise<AssetMetadata | null> {
  try {
    const redis = getRedisConnection();
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as AssetMetadata) : null;
  } catch {
    const hit = memoryCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    return null;
  }
}

async function cacheSet(key: string, value: AssetMetadata, ttlSeconds: number): Promise<void> {
  try {
    const redis = getRedisConnection();
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}

/**
 * Resolve SEP-1 metadata for a credit asset by looking up the issuer's
 * home domain and parsing its stellar.toml. Returns null when the issuer
 * publishes no usable entry (used by the spam filter to detect unlisted
 * assets).
 */
export async function resolveSep1Metadata(
  code: string,
  issuer: string,
  deps: MetadataResolverDeps = {},
): Promise<AssetMetadata | null> {
  const { horizonUrl } = getHorizonUrl();
  const server = deps.server ?? createHorizonServer(horizonUrl);
  const homeDomain = await getIssuerHomeDomain(issuer, { server });
  if (!homeDomain) return null;

  try {
    const toml =
      deps.resolveToml ??
      (StellarToml.Resolver.resolve as unknown as (
        d: string,
      ) => Promise<StellarToml.Api.StellarToml>);

    const doc = await toml(homeDomain);
    const currencies = doc.CURRENCIES ?? [];
    const match = currencies.find(
      (c) =>
        (c.code ?? "").toUpperCase() === code.toUpperCase() &&
        (!c.issuer || c.issuer === issuer),
    );
    if (!match) return null;

    return toMetadata(match, doc.DOCUMENTATION?.ORG_URL);
  } catch (err) {
    log.debug("SEP-1 resolution failed", {
      code,
      issuer,
      homeDomain,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Whether an asset publishes SEP-1 metadata. Cached so portfolio/balance
 * builds can run the spam filter without repeated TOML fetches.
 */
export async function hasPublishedMetadata(
  code: string,
  issuer: string,
  deps: MetadataResolverDeps = {},
): Promise<boolean> {
  if (isNativeCode(code) || !issuer) return true;

  const type = code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
  const key = `assets:listed:${assetKey({ code, issuer, type })}`;

  try {
    const redis = getRedisConnection();
    const raw = await redis.get(key);
    if (raw !== null) return raw === "1";
  } catch {
    // fall through to network resolution
  }

  const listed = (await resolveSep1Metadata(code, issuer, deps)) !== null;

  try {
    const redis = getRedisConnection();
    await redis.set(key, listed ? "1" : "0", "EX", 24 * 60 * 60);
  } catch {
    // in-memory fallback not needed: resolving again is acceptable
  }

  return listed;
}

/**
 * Get metadata for an asset, preferring SEP-1 TOML metadata and falling
 * back to defaults. Results are cached for `metadataCacheTtlSeconds`.
 */
export async function getAssetMetadata(
  code: string,
  issuer: string,
  deps: MetadataResolverDeps = {},
): Promise<AssetMetadata> {
  const config = readAssetServiceConfig();
  if (isNativeCode(code) || !issuer) return nativeMetadata();

  const type = code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
  const key = `assets:meta:${assetKey({ code, issuer, type })}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  const tomlMetadata = await resolveSep1Metadata(code, issuer, deps);
  const metadata = tomlMetadata ?? fallbackMetadata(code.toUpperCase());

  await cacheSet(key, metadata, config.metadataCacheTtlSeconds);
  return metadata;
}