# Global merchant rate limits

The active gateway (`apps/backend/gateway`) uses Node HTTP middleware. Its default
rate limiter now uses one atomic Redis token bucket per authenticated `userId`,
or per resolved client IP for anonymous traffic. The existing authentication model
uses `userId` as its principal; client-supplied merchant IDs and tier headers are
not trusted. Verified JWT roles select the quota:

| Tier | Roles | Capacity | Refill |
| --- | --- | ---: | ---: |
| Free | default | 60 | 1 token/second |
| Verified | `verified`, `merchant`, `pro` | 600 | 10 tokens/second |
| Enterprise | `enterprise` | 3000 | 50 tokens/second |

Enterprise takes precedence. Routes and tiers are excluded from the bucket key,
so switching either cannot create a fresh allowance. Keys hash the principal and
use the `gateway:global-rate:v1:` namespace. All replicas must use the same
`REDIS_URL`. The Lua script reads Redis server time, replenishes fractional tokens,
consumes one token, and sets expiry atomically. A full bucket is initially
available; tokens then refill continuously. This is a token bucket, not a fixed
or rolling-minute counter: initial capacity plus newly replenished tokens can be
consumed in an interval. There is no additional burst allowance.

Successful and denied responses expose `X-RateLimit-Limit` and
`X-RateLimit-Remaining`. Denials return HTTP 429 with a positive, rounded-up
`Retry-After` in seconds. Redis errors return HTTP 503 with `Retry-After: 1`;
there is no local fallback that could multiply quotas across replicas.
Connections have bounded timeouts and reconnect in the background.

Existing trusted-proxy IP resolution, health-check exemption, authenticated
internal-service exemption, explicit legacy overrides, and tighter login and
registration limits remain supported. Sensitive-route denials report the tighter
limit. Those requests also consume a global token.

## Fastify

For Fastify 5 integrations, register before routes:

```ts
import { globalRateLimitPlugin } from "./src/rateLimit/fastifyPlugin.js";
await app.register(globalRateLimitPlugin);
```

The adapter uses the same middleware, authentication and error envelope as the
active gateway. It closes its Redis connection when Fastify closes. An injected
`limiter` remains owned by the caller. The older excluded `apps/gateway`
application is not the active workspace gateway.

## Verification

Build shared packages first, then run the focused checks:

```sh
pnpm --filter @delegolabs/types --filter @delegolabs/utils build
pnpm --filter @delegolabs/gateway test -- src/rateLimit/globalTokenBucket.test.ts src/rateLimit/fastifyPlugin.test.ts middleware/rateLimit.test.ts
RATE_LIMIT_TEST_REDIS_URL=redis://localhost:16379 pnpm --filter @delegolabs/gateway test -- src/rateLimit/globalTokenBucket.redis.test.ts
```

Use a disposable Redis instance for the opt-in integration suite. It creates
unique test keys and deletes only those keys. Four independent clients submit
1000 simultaneous operations for Free and Verified, and 4000 for Enterprise.
A frozen test timestamp isolates atomic quota correctness from elapsed refill:
exactly 60, 600 and 3000 requests must succeed. Separate tests cover fractional
refill, clock rollback, tier changes, expiry and production Redis timestamps.
The Fastify suite also sends 1000 concurrent HTTP injections across two gateway
instances backed by real Redis, asserting 60 successes and 940 HTTP 429s.
These are concurrency/correctness tests, not a measured 1000-RPS network
throughput benchmark; deployment hardware still needs throughput measurement.

For a paced network test, `scripts/load-global-rate-limit.js` configures k6 for
1000 requests/second with up to 1000 concurrent virtual users for ten seconds.
Set `TARGET_URL` to an authenticated GET endpoint that returns 200, `BEARER_TOKEN`
to a valid token, and `QUOTA` to 60, 600 or 3000. Use a fresh principal and an idle,
disposable gateway/Redis environment for each tier. Thresholds reject dropped
iterations, unexpected statuses, malformed headers and admissions above the
initial capacity plus the ten-second refill budget. Do not run against production.
