import { describe, expect, it, vi } from "vitest";
import {
  REALTIME_VISITOR_BUCKET_SECONDS,
  REALTIME_VISITOR_CACHE_TTL_SECONDS,
  RealtimeVisitorsService,
  realtimeVisitorBucketKey,
  type RealtimeVisitorCache,
} from "./realtimeVisitorsService.js";

describe("RealtimeVisitorsService", () => {
  it("counts the current and six-bucket 30-minute window and caches for ten seconds", async () => {
    const cache = new Map<string, string>();
    const redis: RealtimeVisitorCache = {
      get: vi.fn(async (key: string) => cache.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => { cache.set(key, value); return "OK"; }),
      pfcount: vi.fn(async (...keys: string[]) => keys.length === 1 ? 4 : 11),
    };
    const service = new RealtimeVisitorsService(redis);
    const now = new Date("2026-10-21T12:07:00.000Z");
    const merchantId = "6f1c2a9e-1b2c-4d3e-8f00-0123456789ab";

    const result = await service.getRealtimeVisitors(merchantId, now);

    expect(result).toEqual({
      merchantId,
      currentActiveVisitors: 4,
      last30MinutesVisitors: 11,
      windowSizeSeconds: REALTIME_VISITOR_BUCKET_SECONDS,
      calculatedAt: now.toISOString(),
    });
    const bucketStart = Math.floor(now.getTime() / 1000 / REALTIME_VISITOR_BUCKET_SECONDS) * REALTIME_VISITOR_BUCKET_SECONDS;
    expect(redis.pfcount).toHaveBeenNthCalledWith(1, realtimeVisitorBucketKey(merchantId, bucketStart));
    expect(redis.pfcount).toHaveBeenNthCalledWith(2, ...Array.from(
      { length: 6 }, (_, offset) => realtimeVisitorBucketKey(merchantId, bucketStart - offset * REALTIME_VISITOR_BUCKET_SECONDS),
    ));
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining(`:${merchantId}:${bucketStart}`),
      JSON.stringify(result),
      "EX",
      REALTIME_VISITOR_CACHE_TTL_SECONDS,
    );

    await service.getRealtimeVisitors(merchantId, now);
    expect(redis.pfcount).toHaveBeenCalledTimes(2);
  });
});
