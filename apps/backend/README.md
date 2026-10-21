# Backend Services

This directory contains the backend microservices that power the Delego platform. Each service is independently deployable and exposes a health check endpoint.

## 📋 Table of Contents

- [Overview](#overview)
- [Services](#services)
- [Architecture](#architecture)
- [Development](#development)
- [Service Communication](#service-communication)
- [Monitoring](#monitoring)
- [Deployment](#deployment)

## Overview

The backend services directory contains microservices that implement the core business logic of the Delego platform. Each service is designed to be:

- **Independent**: Can be developed and deployed independently
- **Scalable**: Can scale horizontally based on demand
- **Resilient**: Handles failures gracefully
- **Observable**: Provides metrics and logging
- **Secure**: Implements proper security measures

### Service Principles

- **Single Responsibility**: Each service has a single, well-defined purpose
- **API-First**: Services expose well-defined APIs
- **Stateless**: Services are stateless where possible
- **Event-Driven**: Services communicate via events
- **Fail-Safe**: Services degrade gracefully on failure

## Services

### Gateway Service (`apps/backend/gateway`)

**Package**: `@delegolabs/gateway`
**Port**: 3000
**Health Check**: `GET /health`

The API gateway serves as the single entry point for all client requests.

#### Responsibilities

- HTTP API endpoint management
- JWT authentication and validation
- Role-based access control (RBAC)
- Wallet-based authorization
- Rate limiting and throttling
- Request routing to backend services
- API versioning
- Request/response logging
- CORS handling

#### Tech Stack

- Node.js with TypeScript (`@delegolabs/utils` HTTP server)
- JWT for authentication
- Redis for rate limiting
- PostgreSQL for user data

#### Endpoints

- `POST /api/v1/auth/register` - User registration
- `POST /api/v1/auth/login` - User authentication
- `POST /api/v1/auth/refresh` - Token refresh
- `POST /api/v1/auth/logout` - User logout
- `GET/POST /api/v1/delegations` - List / create delegations
- `GET/PATCH/DELETE /api/v1/delegations/:id` - Delegation detail / update / revoke
- `GET /api/v1/wallets/:walletId` - Wallet lookup
- `GET /api/v1/admin/rate-limit/metrics` - Rate-limit metrics
- `GET /api/v1/admin/circuit-breakers` - Circuit breaker status
- `GET /api/docs` - Swagger UI

#### Dynamic Rate Limiting for Unauthenticated Search

Public catalog search endpoints (e.g. `GET /api/v1/search`) are unauthenticated
and therefore rate limited per client IP using a Redis-backed token bucket to
prevent competitor data scraping.

Bucket state is stored in Redis under the key `ratelimit:search:{ip}` and follows
the `SearchRateLimitBucket` shape:

```typescript
export interface SearchRateLimitBucket {
  ip: string;
  remainingTokens: number;
  refillRatePerSec: number;
}
```

- Each IP starts with a full bucket of tokens and refills at `refillRatePerSec`.
- Every unauthenticated search request consumes one token.
- When `remainingTokens` reaches zero, the gateway responds with
  `429 Too Many Requests` and a standard `Retry-After` header indicating how
  many seconds until the next token is available.
- Buckets expire automatically once idle so Redis does not grow unbounded.

### Orchestrator Service (`apps/backend/orchestrator`)

**Package**: `@delegolabs/orchestrator`
**Port**: 3010
**Health Check**: `GET /health`

The orchestrator service coordinates purchase workflows across multiple services.

#### Responsibilities

- Purchase workflow coordination
- State machine management
- Event publishing/subscribing
- Service orchestration
- Workflow persistence
- Error handling and retries
- Timeout management

#### Workflow States

1. `INITIATED` - Order created by user
2. `SEARCHING` - Agent searching for products
3. `FOUND` - Products found, awaiting approval
4. `APPROVED` - User approved purchase
5. `ESCROW_FUNDED` - Funds locked in escrow
6. `PURCHASED` - Purchase completed
7. `DELIVERING` - Delivery in progress
8. `DELIVERED` - Delivery confirmed
9. `COMPLETED` - Order completed
10. `CANCELLED` - Order cancelled
11. `FAILED` - Order failed

#### Tech Stack

- Node.js with TypeScript
- Custom XState-style state machine (no external dependency)
- Event bus (Redis Pub/Sub)
- PostgreSQL for workflow persistence

### Wallet Service (`apps/backend/wallet`)

**Package**: `@delegolabs/wallet`
**Port**: 3012
**Health Check**: `GET /health`

The wallet service manages Stellar wallets and Soroban permissions.

#### Responsibilities

- Stellar account management
- Soroban permission grants
- Transaction signing
- Transaction submission
- Balance tracking
- Key management
- Soroban contract simulation

#### Security Features

- Encrypted key storage
- Hardware Security Module (HSM) integration (Planned)
- Multi-signature support (Planned)
- Session keys for delegated operations

#### Tech Stack

- Node.js with TypeScript
- Stellar SDK for JavaScript
- Soroban RPC client
- PostgreSQL for wallet data

### Payments Service (`apps/backend/payments`)

**Package**: `@delegolabs/payments`
**Port**: 3014
**Health Check**: `GET /health`

The payments service coordinates payment and escrow operations.

#### Responsibilities

- Escrow contract coordination
- Payment event processing
- Settlement execution
- Refund processing
- Payment status tracking
- Transaction monitoring

#### Payment Flow

1. User approves purchase
2. Wallet service signs transaction
3. Payments service funds escrow
4. Escrow contract locks funds
5. Delivery confirmed
6. Escrow releases funds to merchant
7. Settlement recorded

#### Tech Stack

- Node.js with TypeScript
- Soroban SDK
- Stellar SDK
- PostgreSQL for payment records

### Notifications Service (`apps/backend/notifications`)

**Package**: `@delegolabs/notifications`
**Port**: 3015
**Health Check**: `GET /health`

The notifications service sends customer-facing updates.

#### Responsibilities

- Email notifications
- Push notifications
- SMS notifications (Planned)
- Notification templates
- User preferences
- Delivery tracking
- Retry logic

#### Notification Types

- Order status updates
- Payment confirmations
- Approval requests
- Delivery notifications
- Security alerts

#### Tech Stack

- Node.js with TypeScript
- SendGrid for email
- Web Push API for push notifications
- Twilio for SMS (Planned)

### CDC Service (`apps/backend/cdc`)

**Package**: `@delegolabs/cdc`
**Port**: 3017
**Health Check**: `GET /health`

The CDC service implements Change Data Capture for real-time database
synchronization across services. It captures PostgreSQL row changes via native
logical replication (or an external Debezium cluster), transforms them into
domain events, and publishes them to the Redis bus with exactly-once delivery.

#### Responsibilities

- Capture INSERT / UPDATE / DELETE row changes from configured tables
- Transform raw WAL changes into canonical `CDCEvent`s and domain events
- Publish to Redis (durable stream `cdc:events` + real-time pub/sub fan-out)
- Exactly-once delivery via the `cdc_published_events` dedup table + durable
  replication checkpoints
- Schema evolution handling (`cdc_schema_versions`)
- Monitoring dashboard (`GET /cdc/dashboard`) showing WAL lag, throughput, and errors
- Failover / recovery by resuming from the durable slot checkpoint

#### Tech Stack

- Node.js with TypeScript
- PostgreSQL logical replication (native slots, `test_decoding`)
- Redis streams + pub/sub
- `@delegolabs/utils` HTTP server + metrics

#### Endpoints

- `GET /api/v1/cdc/metrics` - CDC `CDCMetrics` snapshot
- `GET /api/v1/cdc/position` - current WAL LSN + lag
- `GET /api/v1/cdc/config` - effective connector config (secrets redacted)
- `GET /cdc/dashboard` - HTML monitoring dashboard
- `GET /metrics` - Prometheus text metrics
- `POST /api/v1/cdc/pause` / `POST /api/v1/cdc/resume` - pipeline control

### DB Vacuum Service (`apps/backend/db-vacuum`)

**Package**: `@delegolabs/db-vacuum`
**Port**: 3022
**Health Check**: `GET /health`

The DB Vacuum service monitors PostgreSQL for table and index bloat on
high-churn tables, alerts when dead tuples cross a threshold, and triggers a
non-blocking `VACUUM ANALYZE`. See [`apps/backend/db-vacuum/README.md`](./db-vacuum/README.md)
for thresholds, configuration and the full safety rationale.

#### Responsibilities

- Scan `pg_stat_user_tables` (`n_dead_tup` / `n_live_tup`) plus per-index size
  and scan counts in a single round trip
- Classify each table onto a `none → critical` severity ladder
- Raise deduplicated alerts (cooldown per rule + table) when thresholds are crossed
- Issue `VACUUM (ANALYZE)` for the worst offenders, worst first and capped per pass
- Report worker metrics and persist a per-table audit trail

#### Safety

- `VACUUM FULL` is impossible by construction — the statement builder has no `full` option
- Identifiers are validated and quoted, never interpolated; system schemas are refused
- Runs on a dedicated autocommit connection with a per-statement `statement_timeout`
- Skips tables already being vacuumed; passes never overlap with each other
- Unused indexes are reported, never dropped
- `DB_VACUUM_DRY_RUN=true` assesses and alerts without issuing any statement

#### Endpoints

- `GET /api/v1/db-vacuum/config` - effective thresholds and run config
- `GET /api/v1/db-vacuum/bloat` - fresh scan + per-table assessments
- `GET /api/v1/db-vacuum/metrics` - worker metrics
- `POST /api/v1/db-vacuum/run` - trigger a pass (`409` if one is in flight)
- `GET /api/v1/db-vacuum/runs` - last run summary

## Architecture

### Service Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      API Gateway                         │
│                   (Port 3000)                             │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        v            v            v
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Orchestrator  │ │    Wallet    │ │   Payments   │
│  (Port 3010)  │ │  (Port 3012) │ │  (Port 3014)  │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │               │               │
       v               v               v
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│    Agents    │ │   Stellar    │ │   Soroban    │
│  (Port 3011)  │ │   Network    │ │   Contracts  │
└──────────────┘ └──────────────┘ └──────────────┘
```

### Service Dependencies

```
Gateway
  ├─> Orchestrator
  │    ├─> Agents
  │    └─> Wallet
  ├─> Wallet
  └─> Payments
       ├─> Wallet
       └─> Soroban Contracts

Notifications (independent, receives events)
```

## Development

### Service Structure

Each service follows a consistent structure:

```
apps/backend/
├── gateway/
│   ├── src/
│   │   ├── routes/
│   │   ├── middleware/
│   │   ├── auth/
│   │   └── index.ts
│   ├── package.json
│   └── tsconfig.json
├── orchestrator/
│   ├── src/
│   │   ├── workflows/
│   │   ├── state/
│   │   └── index.ts
│   ├── package.json
│   └── tsconfig.json
└── ...
```

### Running Services

```bash
# Start all services
pnpm dev

# Start the gateway
pnpm dev:gateway

# Start a specific service
pnpm --filter @delegolabs/orchestrator dev
pnpm --filter @delegolabs/wallet dev
pnpm --filter @delegolabs/payments dev
pnpm --filter @delegolabs/notifications dev
pnpm --filter @delegolabs/cdc dev
pnpm --filter @delegolabs/db-vacuum dev
pnpm --filter @delegolabs/agents dev
```

### Building Services

```bash
# Build all services
pnpm build

# Build specific service
pnpm --filter @delegolabs/gateway build
```

### Testing Services

```bash
# Test all services
pnpm test

# Test specific service
pnpm --filter @delegolabs/gateway test
```

## Service Communication

### HTTP/REST

Services communicate via HTTP/REST for synchronous operations:

```typescript
// Service A calling Service B
const response = await axios.get('http://wallet-service:3012/balance');
```

### Event-Driven

Services communicate via events for asynchronous operations:

```typescript
// Publish event
redis.publish('order:created', JSON.stringify(order));

// Subscribe to event
redis.subscribe('order:created', (message) => {
  // Handle event
});
```

### Service Discovery

Services discover each other via:
- **Development**: Hardcoded localhost URLs
- **Staging**: Kubernetes service discovery
- **Production**: Service mesh (Istio)

## Monitoring

### Health Checks

All services expose a health check endpoint:

```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "ok",
  "service": "gateway",
  "version": "0.0.1",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

### Metrics

Services expose metrics for monitoring:
- Request count
- Request duration
- Error rate
- Active connections
- Custom business metrics

### Logging

Structured logging with correlation IDs:

```typescript
logger.info('Processing request', {
  requestId: 'abc-123',
  userId: 'user-123',
  action: 'create_delegation'
});
```

## Deployment

### Development

Services run locally via Docker Compose:

```bash
pnpm docker:up
pnpm dev
```

### Staging (Planned)

Services will be deployed to a Kubernetes staging cluster. Kubernetes manifests are not yet in this repository:

```bash
kubectl apply -f k8s/staging/
```

### Production (Planned)

Services will be deployed to a Kubernetes production cluster with blue-green deployment. Kubernetes manifests are not yet in this repository:

```bash
kubectl apply -f k8s/production/
```

### Scaling

Services can be scaled horizontally:

```bash
# Scale gateway to 3 replicas
kubectl scale deployment gateway --replicas=3
```

## Best Practices

### Service Design

- **Single Responsibility**: Each service does one thing well
- **API Design**: RESTful API design principles
- **Error Handling**: Consistent error handling across services
- **Idempotency**: Operations should be idempotent where possible
- **Timeouts**: Implement appropriate timeouts for external calls

### Security

- **Authentication**: JWT-based authentication
- **Authorization**: Role-based access control
- **Encryption**: Encrypt sensitive data
- **Secrets Management**: Use secret management systems
- **Input Validation**: Validate all inputs

### Performance

- **Caching**: Cache frequently accessed data
- **Connection Pooling**: Use connection pooling for databases
- **Async Operations**: Use async/await for I/O operations
- **Load Testing**: Perform load testing before deployment

### Reliability

- **Circuit Breakers**: Implement circuit breakers for external calls
- **Retries**: Implement exponential backoff for retries
- **Health Checks**: Implement health checks for monitoring
- **Graceful Shutdown**: Handle shutdown signals gracefully

## Troubleshooting

### Common Issues

**Service won't start**
```bash
# Check logs
pnpm dev:gateway

# Check port availability
lsof -i :3000

# Check dependencies
pnpm install
```

**Service communication issues**
```bash
# Check service health
curl http://localhost:3000/health

# Check network connectivity
ping wallet-service

# Check logs for errors
```

**Database connection issues**
```bash
# Check PostgreSQL is running
docker ps | grep postgres

# Check connection string
echo $DATABASE_URL

# Test connection
psql $DATABASE_URL
```

## Documentation

- [Gateway Service README](./gateway/README.md)
- [Orchestrator Service README](./orchestrator/README.md)
- [Agents Service README](../../agents/README.md)
- [Wallet Service README](./wallet/README.md)
- [Payments Service README](./payments/README.md)
- [Notifications Service README](./notifications/README.md)

---

**Last Updated**: June 2026
