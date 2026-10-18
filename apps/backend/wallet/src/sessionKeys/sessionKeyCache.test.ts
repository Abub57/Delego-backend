import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SessionKeyRevocationCache,
  MAX_LOCAL_CACHE_TTL_MS,
  SESSION_KEY_REVOCATION_CHANNEL,
  isHighValueAmount,
  HIGH_VALUE_THRESHOLD_STROOPS,
} from './sessionKeyCache';

describe('isHighValueAmount', () => {
  it('returns false for amounts at or below the threshold', () => {
    expect(isHighValueAmount(HIGH_VALUE_THRESHOLD_STROOPS.toString())).toBe(false);
    expect(isHighValueAmount('1000')).toBe(false);
  });

  it('returns true for amounts above the threshold', () => {
    expect(isHighValueAmount((HIGH_VALUE_THRESHOLD_STROOPS + 1n).toString())).toBe(true);
  });

  it('fails safe (treats as high-value) for an unparsable amount', () => {
    expect(isHighValueAmount('not-a-number')).toBe(true);
  });
});

describe('SessionKeyRevocationCache', () => {
  let cache: SessionKeyRevocationCache;

  beforeEach(() => {
    vi.useRealTimers();
    cache = new SessionKeyRevocationCache();
  });

  it('returns null on a cache miss', () => {
    expect(cache.get('GUNKNOWN')).toBeNull();
  });

  it('stores and retrieves a fresh entry', () => {
    cache.set({
      keyId: 'vault/path',
      publicKey: 'GTEST',
      ownerAddress: 'user-1',
      expiresAtLedger: 123,
      isRevoked: false,
    });

    const entry = cache.get('GTEST');
    expect(entry).not.toBeNull();
    expect(entry?.isRevoked).toBe(false);
    expect(entry?.ownerAddress).toBe('user-1');
  });

  it('treats an entry older than the 5-second TTL as a miss (Issue #344 bound)', () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);

    cache.set({
      keyId: 'vault/path',
      publicKey: 'GTEST',
      ownerAddress: 'user-1',
      expiresAtLedger: 123,
      isRevoked: false,
    });

    expect(cache.get('GTEST')).not.toBeNull();

    vi.setSystemTime(start + MAX_LOCAL_CACHE_TTL_MS + 1);
    expect(cache.get('GTEST')).toBeNull();
    expect(cache.size()).toBe(0);

    vi.useRealTimers();
  });

  it('markRevoked flips an existing entry to revoked', () => {
    cache.set({
      keyId: 'vault/path',
      publicKey: 'GTEST',
      ownerAddress: 'user-1',
      expiresAtLedger: 123,
      isRevoked: false,
    });

    cache.markRevoked('GTEST');

    const entry = cache.get('GTEST');
    expect(entry?.isRevoked).toBe(true);
    // Fields from the prior entry are preserved.
    expect(entry?.ownerAddress).toBe('user-1');
  });

  it('markRevoked on an unknown key creates a minimal revoked entry', () => {
    cache.markRevoked('GNEVERSEEN');
    expect(cache.get('GNEVERSEEN')?.isRevoked).toBe(true);
  });

  it('broadcastRevocation marks the local entry revoked even without a publisher', async () => {
    cache.set({
      keyId: 'vault/path',
      publicKey: 'GTEST',
      ownerAddress: 'user-1',
      expiresAtLedger: 123,
      isRevoked: false,
    });

    await cache.broadcastRevocation('GTEST');
    expect(cache.get('GTEST')?.isRevoked).toBe(true);
  });

  it('broadcastRevocation publishes to the revocation channel when a publisher is configured', async () => {
    const publisher = { publish: vi.fn().mockResolvedValue(1) };
    const published = new SessionKeyRevocationCache(publisher as any);

    await published.broadcastRevocation('GTEST');

    expect(publisher.publish).toHaveBeenCalledWith(SESSION_KEY_REVOCATION_CHANNEL, 'GTEST');
  });

  it('does not throw when the publisher fails — nodes self-heal via TTL instead', async () => {
    const publisher = { publish: vi.fn().mockRejectedValue(new Error('redis down')) };
    const resilient = new SessionKeyRevocationCache(publisher as any);

    await expect(resilient.broadcastRevocation('GTEST')).resolves.toBeUndefined();
    expect(resilient.get('GTEST')?.isRevoked).toBe(true);
  });

  it('propagates revocation across a simulated multi-node cluster via pub/sub', async () => {
    // Simulate two nodes sharing one Redis pub/sub bus: a fake client where
    // publish() on one instance synchronously invokes the "message"
    // listener registered by subscribe() on the other.
    let messageHandler: ((channel: string, message: string) => void) | undefined;

    const nodeARedis = {
      publish: vi.fn(async (channel: string, message: string) => {
        messageHandler?.(channel, message);
        return 1;
      }),
    };
    const nodeBRedis = {
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, handler: (channel: string, message: string) => void) => {
        if (event === 'message') messageHandler = handler;
      }),
    };

    const nodeA = new SessionKeyRevocationCache(nodeARedis as any);
    const nodeB = new SessionKeyRevocationCache();
    await nodeB.subscribe(nodeBRedis as any);

    nodeB.set({
      keyId: 'vault/path',
      publicKey: 'GSHARED',
      ownerAddress: 'user-1',
      expiresAtLedger: 999,
      isRevoked: false,
    });
    expect(nodeB.get('GSHARED')?.isRevoked).toBe(false);

    // Node A revokes the key — node B should see it revoked without ever
    // having to fall back to its own Redis check.
    await nodeA.broadcastRevocation('GSHARED');

    expect(nodeB.get('GSHARED')?.isRevoked).toBe(true);
  });

  it('a dropped broadcast still bounds staleness to MAX_LOCAL_CACHE_TTL_MS', () => {
    // Regression guard for the exact bug in #344: simulate node B never
    // receiving the pub/sub message at all (e.g. during a network
    // partition) — its cache must still stop trusting the stale entry
    // once the 5-second TTL elapses.
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);

    const nodeB = new SessionKeyRevocationCache();
    nodeB.set({
      keyId: 'vault/path',
      publicKey: 'GSHARED',
      ownerAddress: 'user-1',
      expiresAtLedger: 999,
      isRevoked: false,
    });

    // The revocation on node A never arrives at node B.
    vi.setSystemTime(start + MAX_LOCAL_CACHE_TTL_MS + 1);

    // Node B's cache is now stale and must be treated as a miss, forcing
    // a fresh check against the distributed store rather than trusting
    // the (incorrect) cached "not revoked" state.
    expect(nodeB.get('GSHARED')).toBeNull();

    vi.useRealTimers();
  });
});
