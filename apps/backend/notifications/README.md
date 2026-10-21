# @delegolabs/notifications

Delego **notifications** service with resilient email delivery, automatic retry with exponential backoff, and persistent Dead-Letter Queue (DLQ) for failed emails.

## Development

```bash
pnpm --filter @delegolabs/notifications dev
```

Health check: `GET http://localhost:3015/health`

## Notification Preference Center (Issue #115)

Granular per-channel / per-category controls with frequency options, quiet hours (timezone-aware), org → user inheritance, and a migration tool.

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/preferences/:userId?orgId=<id>` | Effective preference (org defaults inherited where the user made no explicit choice) |
| `PUT` | `/preferences/:userId` | Replace the user's preference document wholesale |
| `PATCH` | `/preferences/:userId` | Apply a partial update (channels, categories, quiet hours, unsubscribe) |
| `GET` | `/preferences/org/:orgId` | Org-level default preferences |
| `PUT` | `/preferences/org/:orgId` | Set org-level default preferences |
| `POST` | `/preferences/migrate` | Run the preference migration tool (legacy v1 → v2) |
| `GET` | `/preferences/migrations` | List preference migration history |

### Preference document

```ts
interface NotificationPreference {
  userId: string;
  orgId?: string;
  channels: Record<"email" | "push" | "in_app" | "sms", ChannelPreference>;
  categories: Record<string, CategoryPreference>;
  quietHours: { enabled: boolean; start: string; end: string; timezone: string };
  globalUnsubscribe: boolean;
  updatedAt: string;
}
```

Each channel carries `enabled`, a `frequency` (`immediate` | `hourly_digest` | `daily_digest` | `weekly_digest`), and per-type toggles. Each category carries `enabled`, allowed `channels`, a `frequency` (`immediate` | `digest`), and `criticalOnly`. Quiet hours are evaluated in the configured IANA timezone; non-critical notifications are suppressed inside the window.

### Inheritance

Org-level defaults (via `/preferences/org/:orgId`) are inherited by users who have not made an explicit choice. A user value that still equals the built-in default is treated as unset and falls through to the org default; explicit (non-default) user choices always win.

### Schema migration

Run `pnpm db:migrate` to apply `023_notification_preference_center.sql`, which adds `org_id`, `preferences` (JSONB), and `version` to `notification_preferences`, creates `org_notification_preferences`, and creates `preference_migrations`. The migration tool converts legacy boolean-only rows into the JSONB document and is safe to re-run.

## Permission Event Listener (Issue #57)

The notifications service can subscribe to on-chain permission lifecycle
events from the Soroban permissions contract and dispatch owner-facing
security alerts (email + Web Push).  The listener is **opt-in** — it boots
only when both required environment variables are set.

### Required environment variables

| Variable                 | Default                 | Purpose                                                                      |
| ------------------------ | ----------------------- | ---------------------------------------------------------------------------- |
| `STELLAR_RPC_URL`        | _none_                  | Soroban RPC endpoint.  Falls back to `SOROBAN_RPC_URL` if both are unset. |
| `SOROBAN_RPC_URL`        | _none_                  | Alias for `STELLAR_RPC_URL` to match the wallet package's variable name.      |
| `PERMISSIONS_CONTRACT_ID`| _none_                  | The deployed permissions contract ID (e.g. `CABC…`).                          |

When either variable is missing the service boots normally and just logs
`Permission event listener disabled (set STELLAR_RPC_URL and …)`.

### Optional tuning

| Variable                              | Default | Purpose                                   |
| ------------------------------------- | ------- | ----------------------------------------- |
| `PERMISSION_EVENT_POLL_INTERVAL_MS`   | `5000`  | Polling cadence against `getEvents`.      |
| `PERMISSION_EVENT_START_LEDGER`       | `0`     | Fallback ledger when no Redis cursor is stored. |

### How it works

1. On boot the listener instantiates `rpc.Server(rpcUrl)` and starts polling
   the permissions contract for events with topic prefix `perm`.
2. Events are decoded from XDR into `PermissionContractEvent` records:
   - `("perm","granted")`  → `permission_granted`
   - `("perm","revoked")`  → `permission_revoked`
   - `("perm","spent")` / `("perm","paused")` / `("perm","resumed")`
     / `("perm","allowdec")` / `("perm","gpaused")` → `permission_updated`
3. The owner Stellar address is resolved to a `WalletNotificationTarget`
   via the existing `WalletLookupAdapter`.  Missing users are silently
   skipped — the listener never throws.
4. Notification payloads are dispatched idempotently using the existing
   `checkAndMarkDispatched` 24h NX key, so duplicate event deliveries never
   produce duplicate emails or pushes.
5. The polling cursor (`notifications:permissions:ledgerCursor`) is
   persisted in Redis so restarts resume from the last processed ledger.
   Combined with `InMemoryProcessedContractEventStore` dedup, replays of
   overlapping ranges are safe.

### Email templates

Three HTML templates live under `templates/`:

- `permission-granted.html`
- `permission-revoked.html`
- `permission-updated.html`

Each receives the keys `owner`, `delegate`, `eventType`, `limitStroops`,
`expiresAtLedger`, `contractId`, `txHash`.  When a field is missing from
the source event (e.g. `limitStroops` on a revoke) the literal string `—`
is substituted so every template renders coherently.

### Operational assumptions

- The shared Postgres instance exposes `wallets.stellar_address` and
  `users.email` via the `DbWalletLookupAdapter`.
- Push subscriptions live in Redis under the same `push:subscriptions:<userId>`
  key used by the rest of the notifications service.
- The RPC hard limit of 100 ledgers per `getEvents` request is respected by
  the listener, which advances the cursor by `processedLedger + 1` after
  each batch.

## Escrow Release Reminders (Issue #587)

A BullMQ worker emails buyers 48h and 12h before an `in_transit` order's
`orders.escrow_deadline`, when the escrow auto-finalizes. It is off by default.

| Variable | Default | Purpose |
|---|---|---|
| `ESCROW_REMINDERS_ENABLED` | `false` | Set to `true` to start the worker (needs Redis) |
| `ESCROW_REMINDER_SCAN_INTERVAL_MS` | `900000` | How often orders are scanned |
| `APP_BASE_URL` | `http://localhost:3000` | Base of the `/orders/:id/confirm` link in the email |

- Requires migration `049_escrow_release_reminders`; whatever moves an order to
  `in_transit` must set `escrow_deadline`. Orders without one get no reminders.
- A reminder is sent once per (order, window): deterministic BullMQ job id plus a
  claim row in `escrow_reminders_sent`, released only if the send fails.
- The order is re-checked at send time; confirmed, disputed or soft-deleted
  orders get nothing.
- Email text comes from the `escrow_release_reminder_*` keys in `src/i18n/*.json`.

## Push Subscription Cleanup (Issue #137)

Push subscriptions are stored with delivery-health metadata (`failureCount`,
`lastFailedAt`, `createdAt`). Call `cleanupUserPushSubscriptions(userId)`
(or the pure `cleanupPushSubscriptions` helper in `push/index.ts`) to remove
entries that exceed cleanup rules:

| Rule | Default | Env override |
|------|---------|--------------|
| Max failed deliveries | 5 | `PUSH_MAX_FAILURES` |
| Stale after last activity | 90 days | `PUSH_STALE_MS` (milliseconds) |

`PushSubscriptionCleanupResult` reports `{ scanned, removed, failed }`.
Legacy bare `PushSubscription` JSON members are still accepted and wrapped
on read.

## Template Render Error Handling (Issue #136)

`renderTemplate` / `renderNamedTemplate` return a `TemplateRenderResult`:

```ts
{ html?: string; text?: string; error?: string }
```

Every `{{placeholder}}` in the HTML must be present in `templateData` before
send. Missing variables or missing template files produce `{ error }` and
`sendEmail` refuses to dispatch a partially rendered message.

## Email Reliability and Retry Mechanism

The notifications service implements resilient email delivery with automatic retry on transient failures and persistent tracking of failed emails.

### Features

- **Automatic Retry**: Transient failures (network timeouts, rate limits, server errors) are retried automatically
- **Smart Classification**: Distinguishes between transient failures (retryable) and permanent failures (unrecoverable)
- **Exponential Backoff**: Retry delays increase exponentially to reduce load during recovery
- **Dead-Letter Queue (DLQ)**: Failed emails are logged to database with complete context for investigation and replay
- **Idempotent**: Supports idempotency keys to prevent duplicate sends across retries

### Configuration

The retry behavior is configured via environment variables:

| Variable | Type | Default | Range | Description |
|----------|------|---------|-------|-------------|
| `EMAIL_MAX_RETRIES` | integer | 3 | 1-10 | Maximum number of retry attempts before moving to DLQ |
| `EMAIL_RETRY_BASE_DELAY_SECONDS` | integer | 2 | 1+ | Base delay in seconds for exponential backoff |
| `EMAIL_DLQ_ENABLED` | boolean | true | true/false | Enable/disable DLQ logging (set to false for testing) |
| `SENDGRID_API_KEY` | string | - | - | SendGrid API key for email dispatch |
| `FROM_EMAIL` | string | noreply@delego.app | - | Sender email address |
| `SMTP_HOST` | string | - | - | Enables pooled SMTP delivery; when unset, SendGrid is used |
| `SMTP_PORT` | integer | 587 | 1-65535 | SMTP server port |
| `SMTP_SECURE` | boolean | port-dependent | true/false | Use TLS immediately; defaults to true on port 465 |
| `SMTP_USER` | string | - | - | Optional SMTP authentication username (set with `SMTP_PASSWORD`) |
| `SMTP_PASSWORD` | string | - | - | Optional SMTP authentication password (set with `SMTP_USER`) |
| `SMTP_RATE_LIMIT` | integer | 100 | 1+ | Maximum SMTP messages per second |

When `SMTP_HOST` is configured it takes precedence over SendGrid. The service
shares one Nodemailer pool with at most 10 connections, up to 100 messages per
connection, and a 30-second socket inactivity timeout. Nodemailer replaces
failed pool connections automatically. Without `SMTP_HOST`, delivery continues
through the existing SendGrid client and requires `SENDGRID_API_KEY`.

### Retry Strategy

Retry attempts follow exponential backoff:

```
delay = 2^(attempt-1) * EMAIL_RETRY_BASE_DELAY_SECONDS, max 120 seconds

With default EMAIL_RETRY_BASE_DELAY_SECONDS=2:
- Attempt 1: immediate
- Attempt 2: ~2 seconds
- Attempt 3: ~4 seconds
- Attempt 4: ~8 seconds (if EMAIL_MAX_RETRIES > 3)
```

### Error Classification

**Transient Errors** (retried):
- HTTP 429 (rate limit)
- HTTP 5xx (server errors)
- Network timeouts (ETIMEDOUT, ECONNREFUSED, ECONNRESET)
- DNS errors
- Socket/file descriptor errors (EMFILE)

**Permanent Errors** (immediate DLQ, no retry):
- HTTP 400 (bad request)
- HTTP 401 (unauthorized)
- HTTP 403 (forbidden)
- HTTP 404 (not found)
- Invalid email format
- Template not found
- Authentication failures

### Database Migration

Run the root migration runner to create the `failed_notifications` table:

```bash
pnpm db:migrate
```

The migration is idempotent and creates:
- `failed_notifications` table with all required columns
- Index on `(recipient, created_at)` for operator queries
- Index on `notification_id` for fast lookup

### DLQ Schema

The `failed_notifications` table stores permanently failed emails:

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | UUID | No | Primary key, auto-generated |
| `notification_id` | UUID | Yes | ID of the notification attempt (for lookup and replay) |
| `recipient` | VARCHAR(255) | No | Email recipient address |
| `template_name` | VARCHAR(100) | No | Email template identifier |
| `payload` | JSONB | No | Complete template data for replay |
| `error_message` | TEXT | Yes | Error message (truncated to 2000 chars) |
| `attempts` | INTEGER | No | Number of retry attempts made |
| `created_at` | TIMESTAMPTZ | No | When failure was logged |
| `updated_at` | TIMESTAMPTZ | No | Last update timestamp |

### Querying the DLQ

Common queries for investigating failed emails:

```sql
-- Find all failed emails for a recipient
SELECT * FROM failed_notifications 
WHERE recipient = 'user@example.com' 
ORDER BY created_at DESC;

-- Find failed emails in the last 24 hours
SELECT * FROM failed_notifications 
WHERE created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;

-- Find emails with specific error
SELECT recipient, error_message, attempts, created_at 
FROM failed_notifications 
WHERE error_message ILIKE '%invalid recipient%'
ORDER BY created_at DESC;

-- Count failures by template
SELECT template_name, COUNT(*) as failure_count 
FROM failed_notifications 
GROUP BY template_name 
ORDER BY failure_count DESC;
```

### Logging

The retry mechanism includes comprehensive logging:

**INFO Level**:
- Each retry attempt with context (notificationId, recipient, attempt count)
- Permanent failure detection
- Configuration loaded on startup

**WARN Level**:
- Email moved to DLQ (after max retries exhausted)
- DLQ insertion failures

**DEBUG Level**:
- Successful email delivery
- Retry delay calculation
- Exponential backoff timing

All logs include:
- `notificationId`: Unique identifier for this notification
- `recipient`: Target email address
- `templateName`: Template used
- `userId`: User associated with notification (for audit trail)
- `attempt`: Current attempt number
- `totalAttempts`: Total attempts made

### Operational Notes

#### Monitoring

Key metrics to monitor:
- Email dispatch success rate by attempt (should increase over time as service stabilizes)
- DLQ row creation rate (sudden spike indicates increased failures)
- Average attempts to success (should average 1-2)
- Retry success rate (should be >80% for transient errors)

#### Alerts

Recommended alerts:
- DLQ row creation rate > 1 per minute
- Email dispatch failure rate > 5% overall
- Retry success rate drops below 70%
- Configuration validation fails on startup

#### Troubleshooting

**Issue: Too many emails in DLQ**
- Check SendGrid API key and rate limits
- Verify recipient email addresses are valid
- Review error messages for patterns
- Consider tuning `EMAIL_MAX_RETRIES` or `EMAIL_RETRY_BASE_DELAY_SECONDS`

**Issue: Delays between retry attempts**
- Review `EMAIL_RETRY_BASE_DELAY_SECONDS` setting
- Check logs for backoff calculation
- Verify system clock is accurate (affects timing)

**Issue: Database connection errors**
- Verify `DATABASE_URL` is set correctly
- Check database is accessible from service
- Review database pool settings (`DATABASE_POOL_MIN`, `DATABASE_POOL_MAX`)

### Testing

Run tests:

```bash
pnpm --filter @delegolabs/notifications test
```

Test coverage includes:
- Unit tests for error classification
- Unit tests for exponential backoff calculation
- Unit tests for sendEmailWithRetry function
- Integration tests for DLQ persistence
- Property-based tests for retry behavior
- Coverage requirement: 85% minimum

### Deployment

Pre-deployment:
1. Review configuration values for target environment
2. Ensure database is accessible and migrations can run
3. Verify SendGrid API key is set
4. Test retry behavior in staging environment

Deployment steps:
1. Deploy new code
2. Run database migrations: `pnpm db:migrate`
3. Verify configuration with `LOG_LEVEL=debug`
4. Monitor logs for configuration validation and first dispatches
5. Query `failed_notifications` table to verify DLQ is working

Rollback:
1. If issues detected, revert code to previous version
2. Existing DLQ entries remain in database (for investigation)
3. Future emails will use new retry configuration after redeploy


