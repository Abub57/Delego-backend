/**
 * Redis Sentinel auto-discovery tests (#401).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sentinelConfigFromEnv,
  isSentinelEnabled,
  clusterConfigFromEnv,
  getCacheClient,
  _resetCacheClientForTesting,
  _setCacheClientForTesting,
} from "./client.js";

describe("sentinelConfigFromEnv", () => {
  it("returns null when REDIS_SENTINELS is unset", () => {
    expect(sentinelConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns null when REDIS_SENTINELS is blank", () => {
    expect(sentinelConfigFromEnv({ REDIS_SENTINELS: "   " } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("parses a comma-separated sentinel list with defaults", () => {
    const config = sentinelConfigFromEnv({
      REDIS_SENTINELS: "sentinel-1:26379,sentinel-2:26379,sentinel-3:26379",
    } as NodeJS.ProcessEnv);

    expect(config).not.toBeNull();
    expect(config!.masterName).toBe("mymaster");
    expect(config!.role).toBe("master");
    expect(config!.sentinels).toEqual([
      { host: "sentinel-1", port: 26379 },
      { host: "sentinel-2", port: 26379 },
      { host: "sentinel-3", port: 26379 },
    ]);
  });

  it("honors master name, role, credentials, and timeouts", () => {
    const config = sentinelConfigFromEnv({
      REDIS_SENTINELS: "s1:26379",
      REDIS_SENTINEL_MASTER: "delego-cache",
      REDIS_SENTINEL_ROLE: "slave",
      REDIS_PASSWORD: "s3cret",
      REDIS_USERNAME: "cache-user",
      REDIS_SENTINEL_TIMEOUT_MS: "5000",
      REDIS_SENTINEL_MAX_WAIT_MS: "15000",
    } as NodeJS.ProcessEnv);

    expect(config!.masterName).toBe("delego-cache");
    expect(config!.role).toBe("slave");
    expect(config!.password).toBe("s3cret");
    expect(config!.username).toBe("cache-user");
    expect(config!.sentinelTimeoutMs).toBe(5000);
    expect(config!.maxDiscoveryWaitMs).toBe(15000);
  });

  it("throws on malformed sentinel entries", () => {
    expect(() =>
      sentinelConfigFromEnv({ REDIS_SENTINELS: "not-a-host" } as NodeJS.ProcessEnv)
    ).toThrow(/REDIS_SENTINELS/);
  });
});

describe("isSentinelEnabled", () => {
  it("is true only when REDIS_SENTINELS is present", () => {
    expect(isSentinelEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isSentinelEnabled({ REDIS_SENTINELS: "s1:26379" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("getCacheClient Sentinel path", () => {
  beforeEach(() => {
    _resetCacheClientForTesting();
  });

  afterEach(() => {
    _resetCacheClientForTesting();
    vi.unstubAllEnvs();
  });

  it("falls back to single-node when Sentinel is not configured", () => {
    const client = getCacheClient(clusterConfigFromEnv({} as NodeJS.ProcessEnv), {
      NODE_ENV: "development",
    } as NodeJS.ProcessEnv);
    expect(client).toBeTruthy();
  });

  it("prefers mock client in test/CI even when Sentinel env is set", () => {
    const client = getCacheClient(clusterConfigFromEnv({} as NodeJS.ProcessEnv), {
      NODE_ENV: "test",
      REDIS_SENTINELS: "s1:26379",
    } as NodeJS.ProcessEnv);
    expect(client).toBeTruthy();
    // Mock path returns before Sentinel construction.
    expect(typeof client.ping).toBe("function");
  });
});
