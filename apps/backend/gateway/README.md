# @delegolabs/gateway

Delego **gateway** service.

## Development

```bash
pnpm --filter @delegolabs/gateway dev
```
Health check: `GET http://localhost:3000/health`

## Error Tracking (Sentry)

The gateway reports unhandled errors to [Sentry](https://sentry.io) when
`SENTRY_DSN` is set. When it is unset, the SDK is never initialised and the
gateway behaves exactly as before (it logs `Sentry disabled` at startup).

| Env var                     | Default     | Notes                                                    |
| --------------------------- | ----------- | -------------------------------------------------------- |
| `SENTRY_DSN`                | _(unset)_   | Project DSN. Enables Sentry. Never commit a real value.  |
| `SENTRY_ENVIRONMENT`        | `NODE_ENV`  | Environment shown in Sentry (e.g. `staging`).            |
| `SENTRY_TRACES_SAMPLE_RATE` | `0`         | Performance tracing sample rate, `0`–`1`. `0` = errors only. |

- Sentry is initialised from `src/instrument.ts`, which must remain the first
  import in `src/index.ts`.
- Errors thrown by route handlers or middleware (or passed to `next(err)`) are
  captured, then handed back to the router so the existing error responses are
  unchanged (`src/observability/sentryRequest.ts`).
- Each event is tagged with `request_id` and `http_method`, and carries
  `user.id` when the request is authenticated. No other user data, headers,
  cookies, query strings or bodies are sent.

## JWT Validation

Access and refresh tokens are validated with [`jsonwebtoken`](https://www.npmjs.com/package/jsonwebtoken).
To tolerate small clock drift between distributed services when validating the
`nbf` (not-before) and `exp` (expiry) claims, the gateway accepts a configurable
clock-skew window.

| Env var                       | Default            | Notes                                                  |
| ----------------------------- | ------------------ | ------------------------------------------------------ |
| `JWT_SECRET`                  | `change-me-...`    | HMAC signing secret. **Must** be overridden in prod.   |
| `JWT_ISSUER`                  | `delego-gateway`   | Expected `iss` claim.                                  |
| `JWT_AUDIENCE`                | `delego-clients`   | Expected `aud` claim.                                  |
| `JWT_CLOCK_TOLERANCE_SECONDS` | `5`                | Allowed clock skew for `nbf` / `exp`. Hard-capped 300. |

The validation contract is exported from
`src/auth/authService.ts` as `JwtValidationConfig`:

```ts
export interface JwtValidationConfig {
  issuer: string;
  audience: string;
  clockToleranceSeconds: number;
}
```

`getJwtValidationConfig()` reads and validates the values from the environment
(invalid/non-numeric values fall back to the default; values above the hard
ceiling are clamped) and `verifyToken()` applies the tolerance to every
verification.

## Middleware

### Delegation Ownership Middleware

The gateway includes a reusable middleware for verifying delegation ownership before update or revoke actions.

**Location**: `apps/backend/gateway/middleware/delegationOwnership.ts`

**Interface**:

```typescript
export interface DelegationOwnershipCheck {
  userId: string;
  delegationId: string;
  owned: boolean;
}
```

**Functions**:

- `verifyDelegationOwnership(delegationIdParam?: string)` - Middleware function that verifies delegation ownership before allowing update or revoke actions. Returns 404 if delegation doesn't exist, 403 if user is not the owner.

- `checkDelegationOwnership(userId: string, delegationId: string)` - Helper function for programmatic ownership checks without middleware.

**Usage Example**:

```typescript
import { route } from "@delegolabs/utils";
import { updateDelegationHandler, revokeDelegationHandler } from "./delegations.js";

// In the routes array
route("PATCH", "/api/v1/delegations/:id", updateDelegationHandler),
route("DELETE", "/api/v1/delegations/:id", revokeDelegationHandler),
```

The ownership check is performed inside the handlers via
`checkDelegationOwnership(userId, delegationId)` — see
`apps/backend/gateway/routes/delegations.ts`. The `verifyDelegationOwnership()`
middleware (in `apps/backend/gateway/middleware/delegationOwnership.ts`) is
available for composing `(req, res, next)` middlewares into routes if needed.

**Error Responses**:

- `404 NOT_FOUND` - Delegation does not exist
- `403 FORBIDDEN` - User does not have permission to modify the delegation

**Testing**: Unit tests are located in `apps/backend/gateway/routes/delegations.test.ts`

## Health Check

Health check endpoint: `GET http://localhost:3000/health`

### Response Format

```json
{
  "data": {
    "status": "ok" | "degraded",
    "service": "gateway",
    "version": "0.0.1",
    "timestamp": "2026-06-24T12:00:00.000Z",
    "dependencies": [
      {
        "name": "postgresql",
        "status": "ok" | "degraded",
        "latencyMs": 15
      }
    ]
  },
  "error": null
}
```

### Dependency Checks

- **PostgreSQL**: Performs a lightweight `SELECT 1` query with a 5-second timeout
  - Status: `ok` when database responds successfully
  - Status: `degraded` when database is unavailable or times out
  - `latencyMs`: Query response time in milliseconds (0 when degraded)

### Overall Status

- `ok`: All dependencies are healthy
- `degraded`: One or more dependencies are unhealthy

The endpoint always returns HTTP 200, even when degraded, to distinguish between endpoint unavailability and service degradation.

## API v1 JSON Body Size Limit

`bodyLimitMiddleware` in `routes/api-v1.ts` rejects oversized JSON payloads on `/api/v1` routes before handlers run.

| Setting | Default | Environment variable |
|---|---|---|
| `jsonLimit` | `100kb` | `GATEWAY_API_V1_JSON_BODY_LIMIT` |
| `routePrefix` | `/api/v1` | (fixed) |

Oversized bodies receive HTTP **413** with the standard error envelope:

```json
{
  "data": null,
  "error": {
    "code": "PAYLOAD_TOO_LARGE",
    "message": "JSON body exceeds limit of 100kb",
    "details": { "limit": "100kb", "maxBytes": 102400 }
  },
  "meta": { "requestId": "...", "timestamp": "..." }
}
```

The limit is checked via `Content-Length` when present and by streaming byte count otherwise. Invalid limit strings fall back to `100kb`.
