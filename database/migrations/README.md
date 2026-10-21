# Database Migrations

Deterministic, checksum-validated SQL migrations for Delego.

## Directory semantics

- `database/schema/` contains the **baseline schema** applied to a brand-new database.
- `database/migrations/` contains **incremental changes** applied after the baseline.
- Baseline files always run before incremental files.
- Within each directory, files run in ascending numeric-prefix order; the filename is the tie-breaker.
The current baseline is:

| Baseline | Description |
|----------|-------------|
| `001_initial.sql` | Users, wallets, orders, delegations, delegation policies, permission levels |
| `002_orchestrator_sagas.sql` | Orchestrator saga coordinator state |
| `003_purchase_workflows.sql` | Purchase workflow state persistence (Issue #54) |

The incremental migrations are:

| Migration | Description |
|-----------|-------------|
| `002_gateway_auth_limits.sql` | Gateway auth columns; spend limit, delegation policy, and permission level tables |
| `003_refresh_tokens.sql` | Refresh token storage |
| `004_processed_contract_events.sql` | Persist processed escrow contract events for deduplication |
| `005_service_event_outbox.sql` | Transactional outbox for reliable Redis / service event publishing (Issue #216) |
| `006_processed_messages.sql` | Idempotent consumer deduplication for Redis and contract-derived events (Issue #217) |
| `007_signing_key_versions.sql` | Signing key version metadata for encrypted wallet seeds (Issue #198) |
| `008_workflow_transition_audit.sql` | Lightweight audit records for workflow transitions (Issue #206) |
| `009_payment_records.sql` | Payment records for escrow coordinator fund/release/refund tracking |
| `010_escrow_funding_locks.sql` | Escrow funding lock table for double-funding prevention |
| `011_workflow_events.sql` | Event sourcing for workflow state transitions (Issue #354) |
| `012_notification_preferences.sql` | Persistent notification preferences per user (#135) |
| `013_soroban_transaction_ledger.sql` | Idempotent Soroban transaction ledger for submission, confirmation, and failure states |
| `014_payment_records_dispute.sql` | Dispute transactions on payment_records for the escrow coordinator |
| `015_oauth_providers.sql` | OAuth2 provider account linking |
| `016_disputes.sql` | Partial refund balance tracking plus dispute mediation, evidence, audit log, and reputation tables (Issue #46) |
| `017_subscriptions.sql` | Recurring payment subscription plans, subscriptions, and the per-period escrow charge ledger (Issue #47) |
| `018_scheduled_notifications.sql` | Durable storage for scheduled/recurring notifications (Issue #59) |
| `019_service_event_outbox_relay.sql` | Retry/claim columns on `service_event_outbox` for the OutboxRelay worker (Issue #33) |
| `020_workflow_compensation_outcomes.sql` | Escrow compensation outcome per workflow record (Issue #35) |
| `021_workflow_timeout_analytics.sql` | Timeout analytics and escalation tracking (#145) |
| `022_redis_pubsub_dead_letters.sql` | Dead letter queue for Redis Pub/Sub failed deliveries (#123) |
| `023_transaction_dlq_and_monitoring.sql` | Transaction DLQ and monitoring tables (#143) |
| `024_soft_delete.sql` | Soft-delete columns, registry, cascade relations, and metrics view for users/wallets/delegations/orders (Issue #67) |
| `025_audit_log.sql` | Append-only, hash-chained audit log with DB-level immutability triggers, plus retention policy config (Issue #66) |
| `026_time_series_optimization.sql` | Native time-series optimization: declarative range partitioning, BRIN acceleration, TOAST compression, retention enforcement, continuous aggregates, data tiering, partitioning automation, and a query benchmark for ts_metrics/ts_events/ts_audit_events |
| `027_human_tasks.sql` | Human task management: `human_tasks`, `task_routing_rules`, `task_comments`, `task_attachments`, and `task_delegations` for workflow tasks requiring manual approval/intervention |
| `028_workflow_templates.sql` | Workflow template registry: `workflow_templates` (versioned definitions), `template_instantiations` (audit trail), and `template_ratings` (marketplace ratings) |
| `029_cdc.sql` | Change Data Capture: idempotent publication outbox (`cdc_published_events`), replication slot checkpoints (`cdc_replication_state`), publication registry (`cdc_publications`), schema-evolution versions (`cdc_schema_versions`), and metric snapshots (`cdc_metric_snapshots`) |
| `030_in_app_notifications.sql` | Durable in-app notifications and indexes (Issues #58/#60) |
| `031_escrow_lock_metrics.sql` | Metrics tracking for escrow funding locks (#147) |
| `032_saga_persistence_extensions.sql` | Saga persistence extensions and event store (#48) |
| `033_payment_method_vault.sql` | Payment method vault storage and audit logs (#110) |
| `034_wallet_signing_audit.sql` | Wallet signing audit logging and provenance (#239) |
| `035_account_recovery.sql` | Account recovery configurations and challenges (#109) |
| `036_notification_preference_center.sql` | Notification preference center: org defaults, JSONB preference documents, and migration history (#115) |
| `037_multi_currency.sql` | Multi-currency payments, FX rates, and currency settlements (#112) |
| `038_product_catalog_vector_search.sql` | Canonical `merchants` and `products` definitions with pgvector embeddings and semantic-search indexes, plus the agent tool audit log (#262/#263) |
| `039_user_agent_memories.sql` | Long-term user preference memory with pgvector embeddings and IVFFLAT index (#266) |
| `040_orchestrator_dlq.sql` | Dead letter queue for failed BullMQ jobs with auto-replay (#310) |
| `041_product_catalog.sql` | Product catalog indexes (unique merchant SKU, price, full-text search) over `products` |
| `042_dual_control_approvals.sql` | Multi-party dual-control quorum approvals and sign-off signatures (#303) |
| `043_spend_metrics.sql` | Daily/monthly completed escrow spend summaries with user/date covering indexes (#306); paired rollback drops both summaries |
| `044_dlq_stack_trace.sql` | Full stack traces and cause chains on orchestrator DLQ records (#347) |
| `045_merchant_inventory_reservations.sql` | Per-order inventory reservation ledger with duplicate-reservation protection (#342) |
| `046_reviews.sql` | Product reviews with buyer verification, review appeals, and order delivery evidence |
| `047_merchant_revenue_analytics.sql` | Currency, platform-fee, and settlement columns plus revenue indexes for `payment_records` |
| `048_merchant_domain_verification.sql` | SEP-0001 `stellar.toml` domain-verification columns, re-check index, and audit trail for merchants |
| `049_column_encryption.sql` | Column-level encryption for PII at rest: data-encryption-key version registry and append-only key-access audit log (#68) |
| `049_custom_domain_certificates.sql` | Merchant custom-domain CNAME verification queue and AES-256-GCM encrypted TLS certificate storage (#597) |
| `049_review_moderation_audit.sql` | Append-only audit trail for administrative review appeal verdicts (#520) |
| `050_purchase_proposals.sql` | Purchase proposals plus delegation spend/version tracking for atomic allowance limits (#265) |
| `051_audit_chain.sql` | Cryptographic SHA-256 tamper-evident audit log chaining with append-only triggers (#358) |
| `052_db_vacuum_run_log.sql` | Per-table vacuum run audit trail for the bloat monitoring worker (#382) |
| `053_dispute_escalation.sql` | Escalation tier columns and stalled-dispute index (#403) |
| `054_escrow_archives.sql` | Cold storage for long-settled escrows populated by the CDC archiver (#290) |
| `055_merchants.sql` | Merchant registration table; a no-op once 038 has created `merchants` |
| `056_merchant_profile_fields.sql` | Merchant profile fields: `support_email` and `webhook_url` |
| `057_merchant_inventory.sql` | Per-merchant/product available and reserved stock counters |
| `058_passkey_credentials.sql` | WebAuthn passkey credentials (public key, signature counter, transports) and single-use ceremony challenges (#367) |
| `059_soroban_event_sync_checkpoints.sql` | Soroban RPC ingestion checkpoints and the processed-event deduplication log (#366) |
| `060_webhook_secret_rotation.sql` | Merchant webhook HMAC signing-secret rotation state and grace periods (#381) |
| `061_product_variants.sql` | Product variants (sizes, colors, materials) with attribute and barcode indexes |
| `062_soroban_contract_events.sql` | Durable, idempotent store for ingested Soroban contract events |
| `20261020_webhook_delivery_forensic_logs.sql` | Granular per-attempt webhook delivery forensic log (`webhook_delivery_logs`): payload SHA-256 hash, HTTP status, latency, response body sample, and error message, with a partial index over failed attempts (`http_status >= 400 OR http_status IS NULL`) |

### Passkey / WebAuthn configuration (#367)

`058_passkey_credentials.sql` backs the passkey ceremonies. The gateway reads
its relying-party settings from the environment; there are no safe defaults for
the RP ID or origins, so both must be set explicitly:

| Variable | Required | Description |
|----------|----------|-------------|
| `WEBAUTHN_RP_ID` | yes | Registrable domain of the relying party (e.g. `passkeys.delego.io`) |
| `WEBAUTHN_ORIGINS` | yes | Comma-separated list of allowed origins |
| `WEBAUTHN_RP_NAME` | no | User-visible name shown by the authenticator (default `Delego`) |
| `WEBAUTHN_USER_VERIFICATION` | no | `required` (default), `preferred` or `discouraged` |
| `WEBAUTHN_ENFORCE_COUNTER` | no | Set to `false` only for synced passkeys that report a constant counter; this forfeits replay detection |
| `WEBAUTHN_CHALLENGE_TTL_MS` | no | Challenge lifetime in ms (default 300000) |

## Naming rules

```text
<unique-number>_<short_description>.sql
```

- Numbers must be unique within their directory and must never be reused.
- Only forward `.sql` files are treated as migrations; matching `.down.sql` files provide rollback SQL and are ignored as standalone migrations.
- Filenames that do not match `<number>_<description>.sql` fail the migration run.

## Tracking

The runner creates a `schema_migrations` table:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  id BIGSERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  migration_group TEXT NOT NULL CHECK (migration_group IN ('schema', 'migration')),
  version INTEGER NOT NULL,
  checksum CHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- Each file is tracked by its relative filename (`schema/001_initial.sql`) and its SHA-256 checksum.
- Each migration runs inside a transaction together with its tracking row, so a failed migration leaves no partial schema and no tracking record.
- Applied files with matching checksums are skipped, making reruns a no-op.
- Editing an already-applied file causes a **checksum mismatch** and the run fails before applying anything else. To change the schema, create a new migration instead.
- Deleting or renaming an applied migration file is also reported as an error.
- Duplicate version numbers within one directory fail validation before any SQL executes.
- Runs are serialized with the PostgreSQL advisory lock `hashtext('delegobackend:schema-migrations')`.

## Commands

```bash
# Apply all pending migrations
pnpm db:migrate

# Show applied/pending migrations and checksum health
pnpm db:migrate:status

# Print pending SQL without executing it
pnpm db:migrate:dry-run

# Generate the next forward/rollback pair
pnpm db:migrate:create add_example

# Roll back the latest migration (requires an explicit safety flag)
pnpm db:migrate -- --direction down --force

# Inspect rollback SQL through version 12
pnpm db:migrate -- --direction down --target 12 --dry-run
```

The runner connects using `DATABASE_URL` (defaults to `postgresql://delego:delego@localhost:5432/delego`). For tests, `DELEGO_SCHEMA_DIR` and `DELEGO_MIGRATIONS_DIR` can override the migration directories.

## Fresh setup

```bash
docker compose up -d --wait postgres
pnpm db:migrate
pnpm db:migrate:status
```

A clean database must contain all expected tables before backend services are started.

## Creating a migration

1. Run `pnpm db:migrate:status` to see the highest applied number.
2. Create `database/migrations/<next-number>_<description>.sql`. Never reuse or renumber existing files.
3. Write plain SQL — each file runs exactly once inside a transaction. Avoid non-transactional statements such as `CREATE INDEX CONCURRENTLY`.
4. Test locally against a clean database (`docker compose down -v && docker compose up -d --wait postgres && pnpm db:migrate`).
5. Update this README's migration table.
6. Never edit an applied migration file: the recorded SHA-256 checksum will no longer match and every subsequent `db:migrate`/`db:migrate:status` fails until the file is restored.

Rollback runs the matching `.down.sql` in a transaction and removes its history row only after the SQL succeeds. A rollback without a down file, or without `--force`, is refused. Review a rollback with `--dry-run` before executing it; production rollback should also be approved through the deployment change process.
