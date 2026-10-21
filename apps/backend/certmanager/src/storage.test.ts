import { describe, expect, it } from "vitest";
import {
  RotatingStorageClient,
  InMemoryStorageObjectStore,
  isAuthError,
} from "../src/storage/rotatingClient.js";
import {
  StorageRotationService,
  StorageRotationScheduler,
  DEFAULT_ROTATION_DAYS,
  DAY_MS,
} from "../src/storage/rotationService.js";
import type { StorageKeyProvider } from "../src/storage/rotationService.js";
import type { StorageKeyPair } from "@delegolabs/types";

/** Fixed service clock so alert/rotation math is deterministic. */
const SERVICE_NOW = new Date("2026-01-01T00:00:00Z");

function baseClientConfig() {
  return {
    bindingId: "r2:delego-uploads",
    provider: "r2" as const,
    bucket: "delego-uploads",
    credentials: {
      primaryKeyId: "key-A",
      primarySecret: "secret-A",
    },
  };
}

function makeClient(overrides: Partial<ReturnType<typeof baseClientConfig>> = {}) {
  return new RotatingStorageClient(
    { ...baseClientConfig(), ...overrides },
    new InMemoryStorageObjectStore(),
  );
}

class InMemoryKeyProvider implements StorageKeyProvider {
  createdKeys: string[] = [];
  revokedKeys: string[] = [];
  private counter = 0;
  /** When set, createKey fails (simulating provider outage / RBAC denial). */
  failCreate = false;
  failRevoke = false;

  async createKey(): Promise<{ keyId: string; secret: string }> {
    if (this.failCreate) throw new Error("provider unavailable: cannot create key");
    const n = ++this.counter;
    const keyId = `key-${String.fromCharCode(65 + n)}`; // key-B, key-C, ...
    this.createdKeys.push(keyId);
    return { keyId, secret: `secret-${keyId.slice(4)}` };
  }

  async revokeKey(keyId: string): Promise<void> {
    if (this.failRevoke) throw new Error(`provider unavailable: cannot revoke ${keyId}`);
    this.revokedKeys.push(keyId);
  }
}

/** Service factory with a mutable clock: use `setClock()` to advance time. */
function makeService(
  client?: RotatingStorageClient,
  options: ConstructorParameters<typeof StorageRotationService>[3] = {},
) {
  let clock = new Date(SERVICE_NOW.getTime());
  const keyClient = client ?? makeClient();
  const provider = new InMemoryKeyProvider();
  const service = new StorageRotationService(keyClient, provider, baseClientConfig(), {
    ...options,
    now: () => new Date(clock.getTime()),
  });
  return {
    service,
    provider,
    client: keyClient,
    setClock: (d: Date) => {
      clock = d;
    },
    getClock: () => clock,
  };
}

const uploadOperation = (body: string) => ({
  description: "put delego/uploads/1.png",
  run: async (creds: { primaryKeyId: string }) => `uploaded-by-${creds.primaryKeyId}:${body}`,
});

describe("RotatingStorageClient — dual-credential fallback", () => {
  it("serves requests with the primary credential by default", async () => {
    const client = makeClient();
    const { result, keySlot } = await client.execute(uploadOperation("a"));
    expect(result).toBe("uploaded-by-key-A:a");
    expect(keySlot).toEqual({ slot: "primary", keyId: "key-A", fallbackUsed: false });
    expect(client.fallbackCount).toBe(0);
  });

  it("falls back to the secondary credential when the primary is rejected", async () => {
    const store = new InMemoryStorageObjectStore();
    store.invalidate("key-A");
    const client = new RotatingStorageClient(
      {
        ...baseClientConfig(),
        credentials: {
          primaryKeyId: "key-A",
          primarySecret: "secret-A",
          secondaryKeyId: "key-B",
          secondarySecret: "secret-B",
        },
      },
      store,
    );

    const { result, keySlot } = await client.execute(uploadOperation("a"));
    expect(result).toBe("uploaded-by-key-B:a");
    expect(keySlot.fallbackUsed).toBe(true);
    expect(keySlot.slot).toBe("secondary");
    expect(keySlot.keyId).toBe("key-B");
    expect(keySlot.failedKeyId).toBe("key-A");
    expect(client.fallbackCount).toBe(1);
  });

  it("re-throws non-auth errors from the primary without falling back", async () => {
    const client = makeClient();
    const failing = async () => {
      await client.execute({
        description: "broken op",
        run: async () => {
          throw new Error("NoSuchKey: delego/uploads/missing.png");
        },
      });
    };
    await expect(failing()).rejects.toThrow(/NoSuchKey/);
    expect(client.fallbackCount).toBe(0);
  });

  it("propagates the error when both credentials fail", async () => {
    const store = new InMemoryStorageObjectStore();
    store.invalidate("key-A");
    store.invalidate("key-B");
    const client = new RotatingStorageClient(
      {
        ...baseClientConfig(),
        credentials: {
          primaryKeyId: "key-A",
          primarySecret: "secret-A",
          secondaryKeyId: "key-B",
          secondarySecret: "secret-B",
        },
      },
      store,
    );
    await expect(client.execute(uploadOperation("a"))).rejects.toThrow(/key-B/);
    expect(client.fallbackCount).toBe(1);
  });

  it("classifies auth errors for fallback decisions", () => {
    expect(isAuthError(new Error("InvalidAccessKeyId: bad key"))).toBe(true);
    expect(isAuthError(new Error("SignatureDoesNotMatch"))).toBe(true);
    expect(isAuthError(new Error("AccessDenied"))).toBe(true);
    expect(isAuthError(new Error("NoSuchKey: nope"))).toBe(false);
    expect(isAuthError(new Error("network timeout"))).toBe(false);
  });

  it("promotes the secondary slot to primary and swaps cleanly", async () => {
    const client = makeClient({
      credentials: {
        primaryKeyId: "key-A",
        primarySecret: "secret-A",
        secondaryKeyId: "key-B",
        secondarySecret: "secret-B",
      },
    });
    const { promotedKeyId, retiringKeyId } = client.promoteSecondaryToPrimary();
    expect(promotedKeyId).toBe("key-B");
    expect(retiringKeyId).toBe("key-A");
    expect(client.keyIds).toEqual({ primary: "key-B", secondary: "key-A" });

    // The promoted key now serves new requests.
    const { keySlot } = await client.execute(uploadOperation("x"));
    expect(keySlot.keyId).toBe("key-B");
  });

  it("rejects promotion when no secondary exists", () => {
    const client = makeClient();
    expect(() => client.promoteSecondaryToPrimary()).toThrow(/no secondary/);
  });
});

describe("StorageRotationService — 90-day rotation with zero downtime", () => {
  it("uses the 90-day default rotation interval", () => {
    expect(DEFAULT_ROTATION_DAYS).toBe(90);
    const { service } = makeService();
    const state = service.getRotationState();
    expect(new Date(state.nextRotationAt).getTime()).toBe(
      new Date("2026-04-01T00:00:00Z").getTime(),
    );
    expect(service.isRotationDue()).toBe(false);
  });

  it("rotates: creates key, verifies, promotes, and keeps both keys valid during grace", async () => {
    const { service, provider, client } = makeService();
    const result = await service.rotate();

    expect(provider.createdKeys).toEqual(["key-B"]);
    expect(result.promotedKeyId).toBe("key-B");
    expect(result.retiringKeyId).toBe("key-A");
    expect(client.keyIds).toEqual({ primary: "key-B", secondary: "key-A" });

    const state = service.getRotationState();
    expect(state.phase).toBe("grace_period");
    expect(state.activeKeyId).toBe("key-B");
    expect(state.retiringKeyId).toBe("key-A");

    // Grace period default is 24h; revocation is scheduled after it.
    expect(new Date(result.revocationAt).getTime()).toBe(
      new Date("2026-01-02T00:00:00Z").getTime(),
    );
    expect(new Date(result.nextRotationAt).getTime()).toBe(
      new Date("2026-04-01T00:00:00Z").getTime(),
    );

    // Both keys are valid during grace — uploads continue on either.
    const duringGrace = await client.execute(uploadOperation("g"));
    expect(duringGrace.keySlot.keyId).toBe("key-B");
    expect(provider.revokedKeys).toEqual([]); // old key still valid
  });

  it("revokes the retiring key only after the grace period elapses", async () => {
    const { service, provider, setClock } = makeService();
    await service.rotate();

    // Still in grace — completeRotation is a no-op and the old key stays valid.
    let completed = await service.completeRotation();
    expect(completed).toBeUndefined();
    expect(provider.revokedKeys).toEqual([]);

    // Advance the clock past the 24h grace period.
    setClock(new Date("2026-01-03T00:00:00Z"));
    completed = await service.completeRotation();
    expect(completed?.revokedKeyId).toBe("key-A");
    expect(provider.revokedKeys).toEqual(["key-A"]);

    const state = service.getRotationState();
    expect(state.phase).toBe("idle");
    expect(state.lastRotatedAt).toBeDefined();
  });

  it("never fails in-flight uploads during rotation (uploads keep succeeding)", async () => {
    const { service, client } = makeService();

    // An "in-flight" upload using the OLD key, started before rotation.
    const inFlight = client.execute(uploadOperation("in-flight"));

    // Rotation happens while the upload is being processed.
    await service.rotate();
    const finished = await inFlight;
    // The upload completes successfully — signed with the still-valid old key.
    expect(finished.result).toBe("uploaded-by-key-A:in-flight");
    expect(finished.keySlot.fallbackUsed).toBe(false);

    // New uploads go through the new key immediately.
    const fresh = await client.execute(uploadOperation("fresh"));
    expect(fresh.result).toBe("uploaded-by-key-B:fresh");
  });

  it("rescues an upload whose key is rejected mid-rotation via slot fallback", async () => {
    const store = new InMemoryStorageObjectStore();
    store.invalidate("key-A");
    const client = new RotatingStorageClient(
      {
        ...baseClientConfig(),
        credentials: {
          primaryKeyId: "key-A",
          primarySecret: "secret-A",
          secondaryKeyId: "key-B",
          secondarySecret: "secret-B",
        },
      },
      store,
    );
    const { result, keySlot } = await client.execute(uploadOperation("rescued"));
    expect(result).toBe("uploaded-by-key-B:rescued");
    expect(keySlot.fallbackUsed).toBe(true);
  });

  it("refuses to start a second rotation while one is in flight", async () => {
    const { service } = makeService();
    await service.rotate();
    await expect(service.rotate()).rejects.toThrow(/already in progress/);
  });

  it("records the failed rotation in metrics and leaves traffic unaffected", async () => {
    const { service, provider, client } = makeService();
    provider.failCreate = true;
    await expect(service.rotate()).rejects.toThrow(/cannot create key/);

    const metrics = service.getMetrics();
    expect(metrics.rotationsFailed).toBe(1);
    expect(metrics.rotationsCompleted).toBe(0);
    expect(metrics.lastRotationError).toMatch(/cannot create key/);

    // Normal traffic continues on the existing key.
    const { keySlot } = await client.execute(uploadOperation("still-up"));
    expect(keySlot.keyId).toBe("key-A");
  });

  it("tracks rotationsCompleted in metrics", async () => {
    const { service } = makeService();
    await service.rotate();
    const metrics = service.getMetrics();
    expect(metrics.rotationsCompleted).toBe(1);
    expect(metrics.lastRotationAt).toBe("2026-01-01T00:00:00.000Z");
    expect(metrics.fallbackActivations).toBe(0);
  });

  it("supports a custom rotation interval and custom grace period", async () => {
    const { service } = makeService(undefined, { rotationDays: 30, gracePeriodMs: 60_000 });
    const result = await service.rotate();
    expect(
      new Date(result.revocationAt).getTime() - SERVICE_NOW.getTime(),
    ).toBe(60_000);
    expect(new Date(result.nextRotationAt).getTime()).toBe(
      new Date("2026-01-31T00:00:00Z").getTime(),
    );
  });

  it("force-completes a rotation immediately (compromise scenario)", async () => {
    const { service, provider, client } = makeService();
    await service.rotate();
    const completed = await service.forceCompleteRotation();
    expect(completed?.revokedKeyId).toBe("key-A");
    expect(provider.revokedKeys).toEqual(["key-A"]);
    expect(client.keyIds).toEqual({ primary: "key-B", secondary: undefined });
    expect(service.getRotationState().phase).toBe("idle");
  });

  it("throws when force-completing with nothing in grace", async () => {
    const { service } = makeService();
    await expect(service.forceCompleteRotation()).rejects.toThrow(/no rotation in grace/);
  });
});

describe("StorageRotationScheduler", () => {
  function makeSchedulerParts() {
    const client = makeClient();
    const provider = new InMemoryKeyProvider();
    let clock = new Date(SERVICE_NOW.getTime());
    const service = new StorageRotationService(client, provider, baseClientConfig(), {
      now: () => new Date(clock.getTime()),
    });
    const scheduler = new StorageRotationScheduler(service, {
      intervalMs: 1000 * 60 * 60,
      now: () => new Date(clock.getTime()),
    });
    return {
      service,
      scheduler,
      provider,
      setClock: (d: Date) => {
        clock = d;
      },
    };
  }

  it("tick() runs rotation when due and completes the previous cycle", async () => {
    const { service, scheduler, provider, setClock } = makeSchedulerParts();

    // Not due yet — tick only evaluates alerts.
    let tick = await scheduler.tick();
    expect(tick.rotated).toBeUndefined();
    expect(tick.alerts.every((a) => a.reason !== "rotation_overdue")).toBe(true);

    // 90 days later: rotation is due, tick performs it.
    setClock(new Date("2026-04-01T00:00:00Z"));
    tick = await scheduler.tick();
    expect(tick.rotated?.promotedKeyId).toBe("key-B");
    expect(provider.revokedKeys).toEqual([]);

    // Past grace (48h): the tick completes the cycle, revoking the old key.
    setClock(new Date("2026-04-03T00:00:00Z"));
    tick = await scheduler.tick();
    expect(tick.rotationCompleted?.revokedKeyId).toBe("key-A");
    expect(provider.revokedKeys).toEqual(["key-A"]);
    expect(service.getRotationState().phase).toBe("idle");
  });

  it("start()/stop() manage the interval timer without leaking", () => {
    const { scheduler } = makeSchedulerParts();
    scheduler.start();
    scheduler.start(); // idempotent
    scheduler.stop();
    scheduler.stop(); // idempotent
    expect(scheduler["timer"]).toBeNull();
  });
});

describe("Storage key expiry alerts (#400)", () => {
  it("emits no alerts for a fresh key far from expiry", () => {
    const client = makeClient({
      credentials: { primaryKeyId: "key-A", primarySecret: "secret-A" },
      primaryExpiresAt: new Date(SERVICE_NOW.getTime() + 80 * DAY_MS).toISOString(),
    });
    const { service } = makeService(client);
    expect(service.evaluateAlerts()).toEqual([]);
  });

  it("warns 14 days out and escalates to critical 7 days out", () => {
    const warnClient = makeClient({
      credentials: { primaryKeyId: "key-A", primarySecret: "secret-A" },
      primaryExpiresAt: new Date(SERVICE_NOW.getTime() + 10 * DAY_MS).toISOString(),
    });
    const { service } = makeService(warnClient);
    const alerts = service.evaluateAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].reason).toBe("key_expiring");
    expect(alerts[0].keyId).toBe("key-A");
    expect(alerts[0].bindingId).toBe("r2:delego-uploads");
    expect(alerts[0].raisedAt).toBeDefined();

    const criticalClient = makeClient({
      credentials: { primaryKeyId: "key-A", primarySecret: "secret-A" },
      primaryExpiresAt: new Date(SERVICE_NOW.getTime() + 3 * DAY_MS).toISOString(),
    });
    const { service: criticalService } = makeService(criticalClient);
    const critical = criticalService.evaluateAlerts();
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe("critical");
  });

  it("marks expired keys as critical with reason key_expired", () => {
    const client = makeClient({
      credentials: { primaryKeyId: "key-A", primarySecret: "secret-A" },
      primaryExpiresAt: new Date(SERVICE_NOW.getTime() - DAY_MS).toISOString(),
    });
    const { service } = makeService(client);
    const alerts = service.evaluateAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].reason).toBe("key_expired");
    expect(alerts[0].expiresAt).toBeDefined();
  });

  it("warns when no secondary key is staged near the rotation window", async () => {
    const client = makeClient({
      credentials: { primaryKeyId: "key-A", primarySecret: "secret-A" },
      primaryExpiresAt: new Date(SERVICE_NOW.getTime() + 200 * DAY_MS).toISOString(),
    });
    const { service, setClock } = makeService(client);
    // Advance to 10 days before the 90-day rotation point (2026-04-01).
    setClock(new Date("2026-03-22T00:00:00Z"));
    const alerts = service.evaluateAlerts();
    const noSecondary = alerts.find((a) => a.reason === "no_secondary");
    expect(noSecondary).toBeDefined();
    expect(noSecondary?.severity).toBe("warning");
    expect(noSecondary?.message).toMatch(/no secondary key staged/);
  });

  it("flags an overdue rotation as critical", async () => {
    const { service, setClock } = makeService();
    setClock(new Date("2026-04-02T00:00:00Z"));
    const alerts = service.evaluateAlerts();
    const overdue = alerts.find((a) => a.reason === "rotation_overdue");
    expect(overdue).toBeDefined();
    expect(overdue?.severity).toBe("critical");
  });

  it("supports custom alert thresholds", () => {
    const client = makeClient({
      credentials: { primaryKeyId: "key-A", primarySecret: "secret-A" },
      primaryExpiresAt: new Date(SERVICE_NOW.getTime() + 20 * DAY_MS).toISOString(),
    });
    const { service } = makeService(client);
    // Default thresholds (14/7): no alert yet at 20 days.
    expect(service.evaluateAlerts()).toEqual([]);
    // Custom warnDays=30: now alerts.
    const alerts = service.evaluateAlerts({ warnDays: 30 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
  });

  it("evaluates both slots during a rotation window", async () => {
    const client = makeClient({
      credentials: { primaryKeyId: "key-A", primarySecret: "secret-A" },
      primaryExpiresAt: new Date(SERVICE_NOW.getTime() + 3 * DAY_MS).toISOString(),
    });
    const { service } = makeService(client);
    await service.rotate();
    // After promotion: the new key (primary) is fresh; the old key (secondary)
    // is in grace until tomorrow — inside the 14-day warning window.
    const alerts = service.evaluateAlerts();
    const secondaryAlert = alerts.find((a) => a.keyId === "key-A" && a.reason === "key_expiring");
    expect(secondaryAlert).toBeDefined();
    // The freshly created key-B must not raise an expiry alert.
    expect(alerts.find((a) => a.keyId === "key-B")).toBeUndefined();
  });
});

describe("StorageKeyPair shape (spec conformance)", () => {
  it("carries id, secret and expiry for each slot", async () => {
    const { service, client } = makeService();
    await service.rotate();
    const primary: StorageKeyPair = client.getPrimary();
    expect(primary.keyId).toBe("key-B");
    expect(primary.secret).toBe("secret-B");
    expect(new Date(primary.expiresAt).getTime()).toBeGreaterThan(SERVICE_NOW.getTime());
    const secondary = client.getSecondary();
    expect(secondary?.keyId).toBe("key-A");
  });

  it("exposes credentials without leaking the secondary when absent", () => {
    const client = makeClient();
    expect(client.credentials).toEqual({
      primaryKeyId: "key-A",
      primarySecret: "secret-A",
    });
  });
});
