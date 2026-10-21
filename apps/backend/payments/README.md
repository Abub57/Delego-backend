# @delegolabs/payments

Delego **payments** service.

### Escrow Funding Lock & Double-Funding Prevention

Protects checkout workflows against race conditions and concurrent deposit attempts on the same order.

- **Atomic Redis Locks**: Uses atomic `SET key lockToken PX ttlMs NX` locks (`escrow:lock:funding:<orderId>`) to prevent duplicate in-flight funding operations.
- **Scripted Release**: Executes an atomic Lua script (`RELEASE_LOCK_LUA`) to ensure lock deletion is only performed by the acquiring lock token.
- **Defense in Depth**: Backed by database unique constraints on `payment_records(order_id)` and `escrow_funding_locks(order_id)` (`010_escrow_funding_locks.sql`).
- **Conflict Responses**: Rejects duplicate concurrent requests with an HTTP `409 Conflict` envelope (`DUPLICATE_FUNDING_REQUEST`) without queuing duplicate blockchain transactions.

See `validation.ts` (`acquireLock`, `releaseLock`) for technical specifications.

### Shipping Exception & Lost Package Detector (Issue #295)

A daily scan over shipped orders that classifies each in-transit shipment and alerts the buyer (and merchant) when a package looks lost.

- **Stalled transit**: no carrier movement for more than 7 business days
  (`SHIPPING_STALLED_MOVEMENT_DAYS`), or more than 10 business days past the
  estimated delivery date (`SHIPPING_ETA_GRACE_BUSINESS_DAYS`). Weekends are
  skipped; there is no holiday calendar.
- **Return to sender** and **delivery failed**: the carrier's latest status says
  the parcel is going back or the attempt failed — flagged immediately, whatever
  the clock says.
- **Flagged once**: a flag is recorded per `(order, reason)`, so a package that
  stays stuck produces one notification, not one a day. Carrier movement clears
  the flag, so a package that stalls twice alerts twice.
- **High-priority notification**: the scan publishes a `shipping_anomaly_detected`
  event on the shared `payments:events` stream with `priority: "high"`,
  `category: "transaction"`, a title/message and a "start a carrier inquiry"
  action, addressed to the buyer and the merchant. The notifications service
  materialises it into the buyer's dashboard from that event.
- **Isolated failures**: a shipment that cannot be classified/flagged is
  collected in the scan result's `errors`; it never aborts the scan.

Entry point: `detectShippingExceptions()` in `src/shipping/exceptionDetector.ts`.
The scheduler runs it once at startup and then every 24h
(`SHIPPING_EXCEPTION_SCAN_INTERVAL_SECONDS`); disable with
`ENABLE_SHIPPING_EXCEPTION_SCAN=false`.

## Development

```bash
pnpm --filter @delegolabs/payments dev
```

Health check: `GET http://localhost:3014/health`

Escrow coordinator health probe: `GET http://localhost:3014/escrow/health`

Returns dependency readiness for escrow funding and settlement:

```json
{
  "data": {
    "database": "ok",
    "walletService": "ok",
    "sorobanRpc": "ok",
    "checkedAt": "2026-06-30T12:00:00.000Z"
  },
  "error": null
}
```

Each dependency reports `"ok"` or `"degraded"`. An unavailable Soroban RPC returns `"degraded"` without failing the endpoint.

## Testing

```bash
# Run tests once
pnpm --filter @delegolabs/payments test

# Watch mode
pnpm --filter @delegolabs/payments exec vitest watch
```

## Environment Configuration

```bash
# Network selection (default: testnet)
STELLAR_NETWORK=testnet|mainnet|futurenet

# Horizon endpoint (optional, uses intelligent defaults)
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

# Wallet service endpoint
WALLET_URL=http://localhost:3012

# PostgreSQL (processed contract events / payment records / funding locks)
DATABASE_URL=postgresql://delego:delego@localhost:5432/delego

# Redis URL for streaming events and funding locks
REDIS_URL=redis://localhost:6379

# Escrow Funding Lock TTL in milliseconds (default: 30000)
ESCROW_LOCK_TTL_MS=30000

# Soroban RPC (escrow contract reads; optional, network-aware default)
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org

# Shipping exception detector (Issue #295)
# Disable the daily scan entirely (default: enabled)
ENABLE_SHIPPING_EXCEPTION_SCAN=true
# Business days without carrier movement before a shipment is flagged (default: 7)
SHIPPING_STALLED_MOVEMENT_DAYS=7
# Business days past the estimated delivery date before a shipment is flagged (default: 10)
SHIPPING_ETA_GRACE_BUSINESS_DAYS=10
# Scan interval in seconds (default: 86400 = daily)
SHIPPING_EXCEPTION_SCAN_INTERVAL_SECONDS=86400

# Currency conversion rate cache (Issue #379)
EXCHANGE_RATE_CACHE_TTL_SECONDS=300
EXCHANGE_RATE_STALE_TTL_SECONDS=86400
EXCHANGE_RATE_REFRESH_INTERVAL_SECONDS=300
EXCHANGE_RATE_PAIRS=USD/XLM,EUR/XLM,USD/BTC,USD/ETH,USD/USDC
EXCHANGE_RATE_CIRCUIT_BREAKER_FAILURE_THRESHOLD=5
EXCHANGE_RATE_CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS=30000
EXCHANGE_RATE_CIRCUIT_BREAKER_HALF_OPEN_SUCCESS=2
ENABLE_EXCHANGE_RATE_CACHE=true
```

## Architecture

- **escrow/**: Escrow contract interactions and fee management
  - `feeEstimator.ts`: Dynamic fee fetching from Horizon
  - `wallet-client.ts`: Wallet service integration
  - `FEE_ESTIMATION.md`: Comprehensive fee estimation guide
- **events/**: Event-driven payment workflows
- **settlement/**: Settlement and reconciliation logic
- **src/**: Core payment service logic and HTTP route handlers
  - `validation.ts`: Escrow funding lock definitions (`acquireLock`, `releaseLock`, `EscrowFundingLock`) and payload validators
  - `routes.ts`: Payment routes with 409 `DUPLICATE_FUNDING_REQUEST` concurrency protections

### Currency Conversion Rate Cache with Circuit Breaker (Issue #379)

Caches fiat-to-crypto exchange rates in Redis with automatic fallback to
last known good rates when the rate oracle API is unreachable.

- **Redis-backed cache**: each pair is stored twice —
  `exchange:rate:<BASE>:<QUOTE>` (fresh copy, short TTL) and
  `exchange:rate:last-good:<BASE>:<QUOTE>` (stale fallback copy, long TTL).
- **Circuit breaker**: oracle refreshes run through
  `src/exchangeRate/circuitBreaker.ts` (closed → open → half-open, same
  pattern as the Soroban RPC breaker); an open circuit short-circuits
  oracle calls instead of stalling reads.
- **Stale fallback**: when the oracle fails (or the circuit is open) reads
  degrade to the last known good rate, flagged `stale: true`, rather than
  erroring — payments keep working through oracle outages.
- **Background refresh**: `startRateRefreshScheduler()` keeps the configured
  `EXCHANGE_RATE_PAIRS` warm on `EXCHANGE_RATE_REFRESH_INTERVAL_SECONDS`.
- **HTTP API**: `GET /exchange-rates/:base/:quote`,
  `POST /exchange-rates/:base/:quote/refresh`,
  `GET /exchange-rates/health`.

