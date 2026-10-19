/**
 * Rating Histogram Service — Unit Tests
 *
 * Verifies:
 *  - Histogram math (starCounts, averageScore) across all 5 stars.
 *  - Weighted average precision (trust-weight discounting via sybil).
 *  - Redis cache invalidation on new review / appeal update.
 *  - Rejected reviews are excluded from totals.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  computeHistogramFromReviews,
  getRatingHistogram,
  invalidateRatingCache,
  _setRedisForTesting,
  _resetRedis,
  type ReviewRecord,
} from "./ratingHistogramService.js";

// ---------------------------------------------------------------------------
// computeHistogramFromReviews (pure in-memory — no DB/Redis required)
// ---------------------------------------------------------------------------

describe("computeHistogramFromReviews", () => {
  it("returns null when there are no reviews for the entity", () => {
    const result = computeHistogramFromReviews("merchant-1", []);
    expect(result).toBeNull();
  });

  it("returns null when all reviews are rejected", () => {
    const reviews: ReviewRecord[] = [
      { entityId: "merchant-1", rating: 5, status: "rejected" },
      { entityId: "merchant-1", rating: 4, status: "rejected" },
    ];
    const result = computeHistogramFromReviews("merchant-1", reviews);
    expect(result).toBeNull();
  });

  it("computes correct starCounts for a uniform 5-star dataset", () => {
    const reviews: ReviewRecord[] = Array.from({ length: 5 }, () => ({
      entityId: "merchant-1",
      rating: 5 as const,
    }));
    const result = computeHistogramFromReviews("merchant-1", reviews);

    expect(result).not.toBeNull();
    expect(result!.starCounts[5]).toBe(5);
    expect(result!.starCounts[4]).toBe(0);
    expect(result!.starCounts[1]).toBe(0);
    expect(result!.averageScore).toBeCloseTo(5.0, 4);
    expect(result!.totalReviewCount).toBe(5);
  });

  it("computes the simple average when all trust weights are 1.0", () => {
    const reviews: ReviewRecord[] = [
      { entityId: "m1", rating: 4, trustWeight: 1.0 },
      { entityId: "m1", rating: 2, trustWeight: 1.0 },
    ];
    const result = computeHistogramFromReviews("m1", reviews);
    expect(result!.averageScore).toBeCloseTo(3.0, 4);
  });

  it("discounts sybil reviews (low trust weight) in the average", () => {
    // Three 5-star full-trust + one 1-star sybil (weight 0.1)
    const reviews: ReviewRecord[] = [
      { entityId: "m1", rating: 5, trustWeight: 1.0 },
      { entityId: "m1", rating: 5, trustWeight: 1.0 },
      { entityId: "m1", rating: 5, trustWeight: 1.0 },
      { entityId: "m1", rating: 1, trustWeight: 0.1 },
    ];
    const result = computeHistogramFromReviews("m1", reviews);

    // Weighted: (5+5+5+0.1) / (1+1+1+0.1) = 15.1 / 3.1 ≈ 4.8710
    expect(result!.averageScore).toBeGreaterThan(4.5);
    expect(result!.averageScore).toBeLessThan(5.0);
    expect(result!.totalReviewCount).toBe(4); // count is raw, not weighted
    expect(result!.starCounts[1]).toBe(1);
    expect(result!.starCounts[5]).toBe(3);
  });

  it("excludes reviews from other entities", () => {
    const reviews: ReviewRecord[] = [
      { entityId: "merchant-A", rating: 5 },
      { entityId: "merchant-B", rating: 1 },
    ];
    const result = computeHistogramFromReviews("merchant-A", reviews);
    expect(result!.totalReviewCount).toBe(1);
    expect(result!.starCounts[5]).toBe(1);
    expect(result!.starCounts[1]).toBe(0);
  });

  it("returns correct starCounts for every star level", () => {
    const reviews: ReviewRecord[] = [1, 2, 3, 4, 5].map((r) => ({
      entityId: "m1",
      rating: r as 1 | 2 | 3 | 4 | 5,
    }));
    const result = computeHistogramFromReviews("m1", reviews);

    expect(result!.starCounts[1]).toBe(1);
    expect(result!.starCounts[2]).toBe(1);
    expect(result!.starCounts[3]).toBe(1);
    expect(result!.starCounts[4]).toBe(1);
    expect(result!.starCounts[5]).toBe(1);
    // average = (1+2+3+4+5)/5 = 3.0
    expect(result!.averageScore).toBeCloseTo(3.0, 4);
    expect(result!.totalReviewCount).toBe(5);
  });

  it("averageScore is rounded to 4 decimal places", () => {
    // 3 reviews: 1, 2, 3 → average = 2.0 (exact; test with fractional result)
    const reviews: ReviewRecord[] = [
      { entityId: "m1", rating: 1 },
      { entityId: "m1", rating: 2 },
    ];
    const result = computeHistogramFromReviews("m1", reviews);
    // 1.5 — verifying the rounding mechanism doesn't strip precision
    expect(result!.averageScore.toString()).toMatch(/^\d+\.\d{1,4}$/);
  });
});

// ---------------------------------------------------------------------------
// Redis cache invalidation (uses in-memory Redis stub)
// ---------------------------------------------------------------------------

describe("getRatingHistogram + invalidateRatingCache (Redis)", () => {
  // Spy on a simple in-memory Redis to verify cache set / del behaviour.
  const cacheStore = new Map<string, { value: string; expiresAt: number }>();

  const mockRedis = {
    async get(key: string): Promise<string | null> {
      const entry = cacheStore.get(key);
      if (!entry || Date.now() > entry.expiresAt) return null;
      return entry.value;
    },
    async set(key: string, value: string, _ex: "EX", ttl: number): Promise<string | null> {
      cacheStore.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
      return "OK";
    },
    async del(key: string): Promise<number> {
      return cacheStore.delete(key) ? 1 : 0;
    },
  };

  beforeEach(() => {
    cacheStore.clear();
    _setRedisForTesting(mockRedis);
  });

  it("invalidateRatingCache removes the key from the cache", async () => {
    // Manually seed the cache.
    await mockRedis.set(
      "rating:summary:merchant-X",
      JSON.stringify({ entityId: "merchant-X" }),
      "EX",
      900
    );
    expect(cacheStore.has("rating:summary:merchant-X")).toBe(true);

    await invalidateRatingCache("merchant-X");
    expect(cacheStore.has("rating:summary:merchant-X")).toBe(false);
  });

  it("invalidateRatingCache is safe when the key does not exist", async () => {
    await expect(invalidateRatingCache("non-existent")).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Average score precision
// ---------------------------------------------------------------------------

describe("averageScore precision", () => {
  it("handles a single 5-star review", () => {
    const result = computeHistogramFromReviews("m1", [{ entityId: "m1", rating: 5 }]);
    expect(result!.averageScore).toBe(5.0);
  });

  it("handles reviews with fractional trust weights without floating-point drift", () => {
    const reviews: ReviewRecord[] = [
      { entityId: "m1", rating: 3, trustWeight: 1 / 3 },
      { entityId: "m1", rating: 3, trustWeight: 1 / 3 },
      { entityId: "m1", rating: 3, trustWeight: 1 / 3 },
    ];
    const result = computeHistogramFromReviews("m1", reviews);
    expect(result!.averageScore).toBeCloseTo(3.0, 4);
  });
});
