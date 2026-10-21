const WEBHOOK_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type CacheEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
  expirationTimer?: ReturnType<typeof setTimeout>;
};

const responseCache = new Map<string, CacheEntry<unknown>>();

export function getWebhookIdempotencyKey(header: string | string[] | undefined): string | undefined {
  const key = Array.isArray(header) ? header[0] : header;
  return key?.trim() || undefined;
}

export function runIdempotently<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const existing = responseCache.get(key) as CacheEntry<T> | undefined;
  if (existing && existing.expiresAt > Date.now()) return existing.promise;
  if (existing) {
    clearTimeout(existing.expirationTimer);
    responseCache.delete(key);
  }

  const entry: CacheEntry<T> = { expiresAt: Number.POSITIVE_INFINITY, promise: Promise.resolve().then(operation) };
  responseCache.set(key, entry);

  entry.promise.then(
    () => {
      if (responseCache.get(key) !== entry) return;
      entry.expiresAt = Date.now() + WEBHOOK_IDEMPOTENCY_TTL_MS;
      entry.expirationTimer = setTimeout(() => {
        if (responseCache.get(key) === entry) responseCache.delete(key);
      }, WEBHOOK_IDEMPOTENCY_TTL_MS);
      entry.expirationTimer.unref?.();
    },
    () => {
      if (responseCache.get(key) === entry) responseCache.delete(key);
    },
  );

  return entry.promise;
}

export function resetWebhookIdempotencyCache(): void {
  for (const entry of responseCache.values()) clearTimeout(entry.expirationTimer);
  responseCache.clear();
}