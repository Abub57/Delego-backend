/** Realtime visitor counts backed by 5-minute Redis HyperLogLogs. */

export const REALTIME_VISITOR_BUCKET_SECONDS = 5 * 60;
export const REALTIME_VISITOR_WINDOW_BUCKETS = 6;
export const REALTIME_VISITOR_CACHE_TTL_SECONDS = 10;

export interface RealtimeVisitorCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: "EX", ttlSeconds: number): Promise<unknown>;
  pfcount(...keys: string[]): Promise<number>;
}

export interface RealtimeVisitorsResponse {
  merchantId: string;
  currentActiveVisitors: number;
  last30MinutesVisitors: number;
  windowSizeSeconds: number;
  calculatedAt: string;
}

export function realtimeVisitorBucketKey(merchantId: string, bucketStartSeconds: number): string {
  return `analytics:visitors:${merchantId}:${bucketStartSeconds}`;
}

export class RealtimeVisitorsService {
  constructor(private readonly redis: RealtimeVisitorCache) {}

  async getRealtimeVisitors(merchantId: string, now = new Date()): Promise<RealtimeVisitorsResponse> {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const currentBucketStart = Math.floor(nowSeconds / REALTIME_VISITOR_BUCKET_SECONDS) * REALTIME_VISITOR_BUCKET_SECONDS;
    const cacheKey = `analytics:realtime-visitors:v1:${merchantId}:${currentBucketStart}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as RealtimeVisitorsResponse;
        if (
          parsed.merchantId === merchantId &&
          Number.isSafeInteger(parsed.currentActiveVisitors) && parsed.currentActiveVisitors >= 0 &&
          Number.isSafeInteger(parsed.last30MinutesVisitors) && parsed.last30MinutesVisitors >= 0 &&
          parsed.windowSizeSeconds === REALTIME_VISITOR_BUCKET_SECONDS &&
          typeof parsed.calculatedAt === "string"
        ) return parsed;
      } catch {
        // Replace a malformed cache entry with a fresh count.
      }
    }

    const buckets = Array.from({ length: REALTIME_VISITOR_WINDOW_BUCKETS }, (_, offset) =>
      realtimeVisitorBucketKey(merchantId, currentBucketStart - offset * REALTIME_VISITOR_BUCKET_SECONDS),
    );
    const [currentActiveVisitors, last30MinutesVisitors] = await Promise.all([
      this.redis.pfcount(buckets[0]),
      this.redis.pfcount(...buckets),
    ]);

    const result: RealtimeVisitorsResponse = {
      merchantId,
      currentActiveVisitors,
      last30MinutesVisitors,
      windowSizeSeconds: REALTIME_VISITOR_BUCKET_SECONDS,
      calculatedAt: now.toISOString(),
    };
    await this.redis.set(cacheKey, JSON.stringify(result), "EX", REALTIME_VISITOR_CACHE_TTL_SECONDS);
    return result;
  }
}
