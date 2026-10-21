/**
 * Local in-memory session-key revocation cache, with bounded staleness and
 * cross-node invalidation via Redis Pub/Sub.
 *
 * Closes #344 — race condition fix:
 * A node's local cache of session-key validity could previously serve a
 * "not revoked" verdict for up to 60 seconds after another node revoked
 * the key, if the Redis pub/sub invalidation message was dropped during
 * network repartitioning — Redis pub/sub delivery is fire-and-forget, so a
 * disconnected subscriber simply never receives the message, with no
 * redelivery or ack.
 *
 * The fix is two-layered:
 *   1. Every local cache entry is capped at a 5-second TTL
 *      (MAX_LOCAL_CACHE_TTL_MS), independent of the session key's real
 *      expiry. Even if the pub/sub broadcast is lost entirely, a node
 *      falls back to the distributed store (Redis) within 5 seconds and
 *      can never serve a stale "not revoked" verdict for longer than that.
 *   2. High-value transactions (see isHighValueAmount) skip the local
 *      cache outright and always check the distributed store directly —
 *      those are exactly the transactions where a delayed-revocation
 *      window is most dangerous.
 */

import type { Redis } from "ioredis";
import { createLogger } from "@delegolabs/utils";
import type { SessionKeyCacheEntry } from "./types.js";

const log = createLogger("wallet:sessionKeyCache", process.env.LOG_LEVEL ?? "info");

/** Hard cap on local cache staleness — see the module doc above. */
export const MAX_LOCAL_CACHE_TTL_MS = 5_000;

/** Above this spend amount, always bypass the local cache and hit the
 *  distributed store directly (task from #344: "Query Redis distributed
 *  store or Soroban state directly for high-value transactions"). */
export const HIGH_VALUE_THRESHOLD_STROOPS = 100_000_000_000n; // 10,000 XLM

export const SESSION_KEY_REVOCATION_CHANNEL = "session_key:revocation";

export function isHighValueAmount(requestedAmountStroops: string): boolean {
  try {
    return BigInt(requestedAmountStroops) > HIGH_VALUE_THRESHOLD_STROOPS;
  } catch {
    // Unparsable amount — fail safe and treat as high-value so the caller
    // goes straight to the distributed store instead of trusting
    // (possibly stale) local cache state.
    return true;
  }
}

export class SessionKeyRevocationCache {
  private readonly entries = new Map<string, SessionKeyCacheEntry>();
  private subscriber: Redis | null = null;

  constructor(private readonly publisher?: Redis) {}

  /**
   * Fast local lookup. Returns null on a miss OR once the 5-second TTL has
   * elapsed, even if the entry's own `expiresAtLedger` is further out —
   * callers must then re-check the distributed store.
   */
  get(sessionPublicKey: string): SessionKeyCacheEntry | null {
    const entry = this.entries.get(sessionPublicKey);
    if (!entry) return null;

    if (Date.now() - entry.cachedAt > MAX_LOCAL_CACHE_TTL_MS) {
      this.entries.delete(sessionPublicKey);
      return null;
    }

    return entry;
  }

  set(entry: Omit<SessionKeyCacheEntry, "cachedAt">): void {
    this.entries.set(entry.publicKey, { ...entry, cachedAt: Date.now() });
  }

  /**
   * Marks a key revoked in the local cache — called directly on the node
   * that performed the revocation, and from the pub/sub subscriber when a
   * peer node broadcasts a revocation.
   */
  markRevoked(sessionPublicKey: string): void {
    const existing = this.entries.get(sessionPublicKey);
    this.entries.set(sessionPublicKey, {
      keyId: existing?.keyId ?? sessionPublicKey,
      publicKey: sessionPublicKey,
      ownerAddress: existing?.ownerAddress ?? "",
      expiresAtLedger: existing?.expiresAtLedger ?? 0,
      isRevoked: true,
      cachedAt: Date.now(),
    });
  }

  delete(sessionPublicKey: string): void {
    this.entries.delete(sessionPublicKey);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Broadcasts a revocation to every other node's cache via Redis Pub/Sub,
   * and applies it to this node's own cache immediately. Best-effort: if
   * the publish itself fails, or the message never reaches a partitioned
   * node, that node's cache still self-heals within
   * MAX_LOCAL_CACHE_TTL_MS the next time it checks this key against Redis.
   */
  async broadcastRevocation(sessionPublicKey: string): Promise<void> {
    this.markRevoked(sessionPublicKey);

    if (!this.publisher) return;
    try {
      await this.publisher.publish(SESSION_KEY_REVOCATION_CHANNEL, sessionPublicKey);
    } catch (err) {
      log.warn("Failed to broadcast session key revocation — peer nodes will self-heal via TTL", {
        sessionPublicKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Subscribes to revocation broadcasts from other nodes. Requires a Redis
   * connection dedicated to subscribe mode — ioredis puts a client that
   * calls `.subscribe()` into a mode where it can no longer run normal
   * commands, so this must not be the same client used for `get`/`setex`.
   */
  async subscribe(subscriberRedis: Redis): Promise<void> {
    this.subscriber = subscriberRedis;
    await this.subscriber.subscribe(SESSION_KEY_REVOCATION_CHANNEL);
    this.subscriber.on("message", (channel: string, sessionPublicKey: string) => {
      if (channel === SESSION_KEY_REVOCATION_CHANNEL) {
        this.markRevoked(sessionPublicKey);
        log.info("Session key revocation received from peer node", { sessionPublicKey });
      }
    });
  }

  async unsubscribe(): Promise<void> {
    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(SESSION_KEY_REVOCATION_CHANNEL);
      } catch {
        // Best-effort on teardown.
      }
      this.subscriber = null;
    }
  }
}
