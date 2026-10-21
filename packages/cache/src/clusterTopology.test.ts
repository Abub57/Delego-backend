import { describe, it, expect } from "vitest";
import {
  parseNodeList,
  clusterTopologyFromEnv,
  resolveScaleReads,
  buildClusterOptions,
} from "./clusterTopology.js";
import { clusterConfigFromEnv } from "./client.js";

describe("parseNodeList", () => {
  it("returns an empty list for unset or empty input", () => {
    expect(parseNodeList(undefined)).toEqual([]);
    expect(parseNodeList("")).toEqual([]);
    expect(parseNodeList("   ")).toEqual([]);
  });

  it("splits a comma-separated host:port list", () => {
    expect(parseNodeList("10.0.0.1:6379, 10.0.0.2:6379 ,10.0.0.3:6379")).toEqual([
      "10.0.0.1:6379",
      "10.0.0.2:6379",
      "10.0.0.3:6379",
    ]);
  });

  it("defaults a bare host to port 6379", () => {
    expect(parseNodeList("redis-a,redis-b")).toEqual([
      "redis-a:6379",
      "redis-b:6379",
    ]);
  });

  it("drops empty and malformed entries rather than producing unusable nodes", () => {
    expect(parseNodeList("10.0.0.1:6379,,10.0.0.2:notaport,10.0.0.3:70000,:6379")).toEqual([
      "10.0.0.1:6379",
    ]);
  });

  it("deduplicates repeated nodes", () => {
    expect(parseNodeList("10.0.0.1:6379,10.0.0.1:6379, 10.0.0.1:6379")).toEqual([
      "10.0.0.1:6379",
    ]);
  });

  it("keeps distinct ports on the same host as separate nodes", () => {
    expect(parseNodeList("10.0.0.1:6379,10.0.0.1:6380")).toEqual([
      "10.0.0.1:6379",
      "10.0.0.1:6380",
    ]);
  });
});

describe("clusterTopologyFromEnv", () => {
  it("reads masters and replicas from the environment", () => {
    const topology = clusterTopologyFromEnv({
      REDIS_CLUSTER_NODES: "10.0.0.1:6379,10.0.0.2:6379,10.0.0.3:6379",
      REDIS_CLUSTER_REPLICA_NODES: "10.0.0.1:6380,10.0.0.2:6380,10.0.0.3:6380",
    } as NodeJS.ProcessEnv);

    expect(topology.masters).toEqual([
      "10.0.0.1:6379",
      "10.0.0.2:6379",
      "10.0.0.3:6379",
    ]);
    expect(topology.replicas).toEqual([
      "10.0.0.1:6380",
      "10.0.0.2:6380",
      "10.0.0.3:6380",
    ]);
  });

  it("enables read-only replicas by default", () => {
    const topology = clusterTopologyFromEnv({} as NodeJS.ProcessEnv);
    expect(topology.enableReadOnlyReplicas).toBe(true);
    expect(topology.masters).toEqual([]);
    expect(topology.replicas).toEqual([]);
  });

  it("disables read-only replicas when REDIS_ENABLE_READ_ONLY_REPLICAS=false", () => {
    const topology = clusterTopologyFromEnv({
      REDIS_ENABLE_READ_ONLY_REPLICAS: "false",
      REDIS_CLUSTER_REPLICA_NODES: "10.0.0.1:6380",
    } as NodeJS.ProcessEnv);

    expect(topology.enableReadOnlyReplicas).toBe(false);
  });
});

describe("resolveScaleReads", () => {
  it("returns 'slave' so ioredis scales reads onto replicas", () => {
    expect(resolveScaleReads(true)).toBe("slave");
  });

  it("returns 'master' when replica reads are disabled", () => {
    expect(resolveScaleReads(false)).toBe("master");
  });
});

describe("buildClusterOptions", () => {
  it("configures scaleReads: 'slave' for read-replica routing", () => {
    const options = buildClusterOptions(
      clusterConfigFromEnv({} as NodeJS.ProcessEnv)
    );

    expect(options.scaleReads).toBe("slave");
  });

  it("falls back to scaleReads: 'master' when replica reads are disabled", () => {
    const options = buildClusterOptions(
      clusterConfigFromEnv({
        REDIS_ENABLE_READ_ONLY_REPLICAS: "false",
      } as NodeJS.ProcessEnv)
    );

    expect(options.scaleReads).toBe("master");
  });

  it("carries the timeouts and redirection limit onto the node connections", () => {
    const options = buildClusterOptions({
      ...clusterConfigFromEnv({} as NodeJS.ProcessEnv),
      maxRedirections: 8,
      connectTimeout: 1234,
      commandTimeout: 567,
    });

    expect(options.maxRedirections).toBe(8);
    expect(options.redisOptions?.connectTimeout).toBe(1234);
    expect(options.redisOptions?.commandTimeout).toBe(567);
  });

  it("enables node reconnection via clusterNodeRetryStrategy", () => {
    // ioredis defaults clusterNodeRetryStrategy to null, which disables
    // reconnection entirely — a replica that restarts would never come back.
    const config = clusterConfigFromEnv({} as NodeJS.ProcessEnv);
    const options = buildClusterOptions(config);

    expect(options.clusterNodeRetryStrategy).toBe(config.retryStrategy);
    expect(typeof options.clusterNodeRetryStrategy).toBe("function");
    expect(
      (options.clusterNodeRetryStrategy as (times: number) => number)(1)
    ).toBe(100);
  });

  it("holds commands until the cluster reports ready and refreshes slots", () => {
    const options = buildClusterOptions({
      ...clusterConfigFromEnv({} as NodeJS.ProcessEnv),
      slotsRefreshIntervalMs: 1234,
    });

    expect(options.enableReadyCheck).toBe(true);
    expect(options.slotsRefreshInterval).toBe(1234);
  });

  it("passes a password through only when one is configured", () => {
    const withoutPassword = buildClusterOptions(
      clusterConfigFromEnv({} as NodeJS.ProcessEnv)
    );
    expect(withoutPassword.redisOptions?.password).toBeUndefined();

    const withPassword = buildClusterOptions(
      clusterConfigFromEnv({ REDIS_PASSWORD: "s3cret" } as NodeJS.ProcessEnv)
    );
    expect(withPassword.redisOptions?.password).toBe("s3cret");
  });
});

describe("clusterConfigFromEnv — read-replica and health-check settings", () => {
  it("applies defaults that keep replica reads on", () => {
    const config = clusterConfigFromEnv({} as NodeJS.ProcessEnv);

    expect(config.enableReadOnlyReplicas).toBe(true);
    expect(config.healthCheckIntervalMs).toBe(5_000);
    expect(config.healthCheckTimeoutMs).toBe(2_000);
    expect(config.healthCheckFailureThreshold).toBe(3);
    expect(config.slotsRefreshIntervalMs).toBe(5_000);
  });

  it("honors the health-check overrides", () => {
    const config = clusterConfigFromEnv({
      REDIS_ENABLE_READ_ONLY_REPLICAS: "false",
      REDIS_HEALTH_CHECK_INTERVAL_MS: "1000",
      REDIS_HEALTH_CHECK_TIMEOUT_MS: "250",
      REDIS_HEALTH_CHECK_FAILURE_THRESHOLD: "5",
      REDIS_SLOTS_REFRESH_INTERVAL_MS: "10000",
    } as NodeJS.ProcessEnv);

    expect(config.enableReadOnlyReplicas).toBe(false);
    expect(config.healthCheckIntervalMs).toBe(1_000);
    expect(config.healthCheckTimeoutMs).toBe(250);
    expect(config.healthCheckFailureThreshold).toBe(5);
    expect(config.slotsRefreshIntervalMs).toBe(10_000);
  });
});