# Audit log SIEM integration + retention/archival guide (Issue #66)

> **Status: design + runbook, not a live integration.** Everything in this
> document describes how to forward `audit_log` events to a SIEM and how to
> enforce `audit_retention_policies` against real object storage. Nothing
> here has been deployed, connected to a real SIEM, or run against real S3
> or cold storage from this repository — there is no SIEM endpoint, no
> cloud storage credentials, and no scheduler available in this
> environment. Treat the flows below as **designs to implement during
> actual deployment**, not integrations already built. The audit logging
> itself — the `audit_log` table, the append-only trigger, the hash chain,
> `recordAuditEntry`/`queryAuditLog`/`verifyChain`, and the
> `/api/v1/admin/audit-log` query API — is real, tested code; see
> `packages/utils/src/audit/` and `database/migrations/025_audit_log.sql`.

## 1. What's already real vs. what this document covers

| Capability | Status |
|---|---|
| `audit_log` table, append-only trigger, indexes | Real (migration 018) |
| `sequence_num`-ordered hash chain (`entry_hash`/`prev_hash`) | Real, tested (`packages/utils/src/audit/hashChain.ts`) |
| `recordAuditEntry` / `queryAuditLog` / `getChainSegment` | Real, tested (`packages/utils/src/audit/auditLogStore.ts`) |
| `GET /api/v1/admin/audit-log`, `GET /api/v1/admin/audit-log/verify` | Real, tested (`apps/backend/gateway/routes/audit.ts`) |
| Whole-chain verification CLI (`verifyStoredChain`) | Real, tested (`packages/utils/src/audit/verifyStoredChain.ts`, `apps/backend/gateway/scripts/verify-audit-chain.ts`) |
| `audit_retention_policies` config table | Real (schema only — stores the policy) |
| Forwarding audit events to a SIEM | Design only, this document, §2 |
| Automated archival to S3/cold storage per `RetentionPolicy` | Design only, this document, §3 |
| Recurring chain-integrity monitoring job | Design only, this document, §4 |

## 2. SIEM integration

### 2.1 Why forward at all, given the DB is already tamper-evident

The hash chain (`hashChain.ts`, §1 above) proves tampering happened; it doesn't
by itself get anyone paged when it does, and a SIEM is also where security
teams typically want cross-system correlation (audit_log events alongside
auth logs, network logs, etc.) rather than a bespoke query API per service.
Forwarding is about **detection and correlation**, not an additional
integrity guarantee — the guarantee already lives in the DB trigger + hash
chain.

### 2.2 Recommended shape: outbox, not a synchronous call in `recordAuditEntry`

`recordAuditEntry` must stay fast and must not fail (or partially apply)
because a downstream SIEM is slow or down — audit logging is often on the
critical path of the operation being audited (e.g. a soft-delete or a
funds-moving update). Two options:

**Option A — polling outbox (recommended).** A separate worker polls
`audit_log` by `sequence_num` (using a small `siem_forward_cursor` table
holding the last forwarded `sequence_num`), batches new rows, and POSTs
them to the SIEM's ingestion endpoint (or writes to a Kafka/Kinesis topic
the SIEM consumes from, if the org's SIEM is stream-based rather than
HTTP-push). This mirrors the existing pattern in
`apps/backend/orchestrator/src/events/service-event-outbox.ts` for
outbox-style forwarding already used elsewhere in this codebase — same
shape, different sink.

```sql
CREATE TABLE IF NOT EXISTS siem_forward_cursor (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),  -- singleton row
  last_forwarded_sequence_num BIGINT NOT NULL DEFAULT 0
);
INSERT INTO siem_forward_cursor (id) VALUES (TRUE) ON CONFLICT DO NOTHING;
```

```text
loop every N seconds:
  cursor = SELECT last_forwarded_sequence_num FROM siem_forward_cursor
  batch  = SELECT * FROM audit_log WHERE sequence_num > cursor
           ORDER BY sequence_num ASC LIMIT 500
  if batch empty: continue
  send batch to SIEM (see §2.3 for payload shape)
  on success: UPDATE siem_forward_cursor SET last_forwarded_sequence_num = max(batch.sequence_num)
  on failure: leave cursor unchanged, retry with backoff next loop
              (at-least-once delivery — the SIEM side should dedupe on `id`)
```

**Option B — DB-level LISTEN/NOTIFY or logical replication**, for near
real-time forwarding instead of polling latency. Higher operational
complexity (a replication slot or a `NOTIFY` trigger to maintain); only
worth it if the SIEM SLA genuinely requires sub-poll-interval latency.
Not recommended as a first implementation — start with Option A, revisit
if polling latency (e.g. 10-30s) doesn't meet requirements.

### 2.3 Payload shape (CEF/LEEF-agnostic JSON, adapt per SIEM vendor)

Most SIEMs (Splunk HEC, Datadog Logs, Elastic, Sentinel) accept structured
JSON over HTTP; vendor-specific formats (CEF, LEEF) are a thin transform
over the same fields:

```json
{
  "event_id": "<audit_log.id>",
  "sequence_num": "<audit_log.sequence_num>",
  "event_type": "data_modification",
  "table": "<table_name>",
  "record_id": "<record_id>",
  "operation": "<INSERT|UPDATE|DELETE>",
  "actor": {
    "user_id": "<user_id>",
    "session_id": "<session_id>",
    "ip_address": "<ip_address>",
    "user_agent": "<user_agent>"
  },
  "changed_fields": ["..."],
  "occurred_at": "<occurred_at, ISO-8601>",
  "transaction_id": "<transaction_id>",
  "integrity": {
    "entry_hash": "<entry_hash>",
    "prev_hash": "<prev_hash>"
  }
}
```

Deliberately **excluded from the forwarded payload**: `old_values`/
`new_values`. Those can contain sensitive data (PII, financial amounts,
auth secrets in edge cases) that shouldn't leave the primary DB's trust
boundary by default. If the SIEM needs before/after diffs for specific
tables, allowlist those tables explicitly and redact known-sensitive
columns (e.g. hashed passwords, tokens) rather than forwarding
`old_values`/`new_values` wholesale.

### 2.4 What to alert on

| Signal | Why it matters |
|---|---|
| `GET /api/v1/admin/audit-log/verify` returns `valid: false` | Tamper detected — page immediately, treat as a security incident |
| SIEM forwarder cursor stalls (no forward in > 5 min under normal traffic) | Forwarder down or SIEM unreachable — detection blind spot |
| Spike in `DELETE` operations on a sensitive table from a single `user_id` | Possible mass-deletion / account compromise |
| `operation = 'DELETE'` on `audit_log` itself | Should be impossible (DB trigger blocks it) — if the SIEM ever sees this, the trigger was bypassed by a superuser and needs investigation |

`GET /api/v1/admin/audit-log/verify` is designed for on-demand/scheduled
calls (e.g. a cron hitting it every N minutes and alerting on
`valid: false`), not a per-request check — walking the full chain is
O(n) in audit log size, so scope it with `from`/`to` for a recent window
in a recurring job rather than verifying the entire history every time
(see §4).

## 3. Retention and archival

### 3.1 The policy table (already shipped)

`audit_retention_policies` (migration 018) stores, per table:

| Column | Meaning |
|---|---|
| `retention_days` | How long entries stay in the live `audit_log` table before archival/deletion is eligible |
| `archive_after_days` | If set, archive (don't delete) after this many days — nullable, meaning "never archive, just delete at `retention_days`" |
| `archive_storage` | `'s3'` or `'cold_storage'` |

Example seed data an operator would insert once real policies are decided
(not inserted by the migration — the migration only creates the table):

```sql
INSERT INTO audit_retention_policies (table_name, retention_days, archive_after_days, archive_storage)
VALUES
  ('users', 2555, 365, 's3'),         -- 7yr retention, archive after 1yr (financial/compliance-adjacent)
  ('orders', 2555, 365, 's3'),
  ('wallets', 2555, 365, 's3'),
  ('delegations', 1095, 180, 'cold_storage');  -- 3yr retention, shorter hot window
```

Actual retention periods are a compliance/legal decision (this repo has
no compliance function to consult) — the numbers above are illustrative,
not a recommendation.

### 3.2 Why archival, not deletion, for a hash-chained log

**Archival must never delete a row still linked into the live chain
without also relocating it** — deleting an old entry from `audit_log`
without preserving its `entry_hash`/`prev_hash` breaks `verifyChain` for
every entry after it, permanently. Two safe approaches:

**Approach A — archive whole chain segments, verify before and after.**
1. Pick an archival cutoff (`occurred_at < NOW() - archive_after_days`).
2. Run `getChainSegment({ to: cutoff })` and `verifyChain()` on it —
   confirm the segment to be archived is itself intact before moving it.
3. Export the segment as an immutable object (e.g. one JSON-lines file per
   day) to S3/cold storage with the same hash-chain fields intact, so the
   archive itself remains independently verifiable.
4. Only after the export is confirmed written (checksum-verified read-back
   from the object store), delete the archived rows from the live table.
5. **The chain in the live table now starts fresh at the first
   post-cutoff entry with a `prev_hash` pointing at nothing** (or, better:
   store the last archived entry's `entry_hash` in a small
   `audit_chain_checkpoints` table so `verifyChain` on the live table can
   still be told "the chain's true previous hash before entry N was X",
   preserving end-to-end verifiability across the archive boundary
   instead of silently starting a new chain).

**Approach B — never delete from Postgres; rely on table partitioning +
tiered storage.** Partition `audit_log` by month (`PARTITION BY RANGE
(occurred_at)`), and move old partitions to cheaper storage (e.g. a
separate tablespace on slower/cheaper disks, or a foreign table backed by
S3 via a FDW) rather than exporting out of Postgres entirely. Simpler
operationally (no export/verify/delete pipeline), but doesn't reduce
primary-database storage footprint the way true archival to
S3/cold-storage does — worth considering if compliance only requires
"retained and queryable," not "off the primary DB."

Recommendation for a first implementation: **Approach A**, since the
issue specifically calls for `archive_storage: 's3' | 'cold_storage'`,
implying data actually leaves the primary DB.

### 3.3 What's NOT implemented here

- The archival job/worker itself (a script or scheduled task running
  §3.2's steps) — not written, since it needs real S3/cold-storage
  credentials and a real scheduler (cron, a job queue, etc.) to run
  against, none of which exist in this sandbox.
- The `audit_chain_checkpoints` table mentioned in §3.2 step 5 — proposed
  design, not created by migration 018. Add it alongside the first
  archival job implementation, informed by whichever approach is chosen.
- Legal/compliance sign-off on actual retention periods per table.

## 4. Chain-integrity monitoring job (recommended operational process)

A recurring job (e.g. every 15 minutes) that:

1. Tracks its own cursor (similar to §2.2's `siem_forward_cursor`) of the
   last-verified `sequence_num`.
2. Calls `getChainSegment` from that cursor forward (bounded, e.g. last
   10,000 entries or since the last run) and `verifyChain` on the result.
3. On `valid: false`: page on-call, include `firstBrokenEntryId` and
   `reason` from the `ChainVerificationResult` in the alert.
4. On success: advance the cursor.

This is the same shape as `GET /api/v1/admin/audit-log/verify` (which
this job could call directly rather than reimplementing the query), just
run on a schedule with alerting wired to the result instead of an
on-demand HTTP call. Not scheduled anywhere in this repo — no job
scheduler is wired up to invoke it.

For a job that has no HTTP access to the gateway (e.g. a cron running on
the database host), run the standalone CLI instead — it walks the whole
stored chain, paging past `getChainSegment`'s 10 000-row default so
tampering later in the log is still caught, and exits non-zero when the
chain is broken:

```sh
pnpm --filter @delegolabs/gateway exec tsx scripts/verify-audit-chain.ts
```

Add `--to <ISO-8601>` to bound the check to a window ending at a given
timestamp, or `--json` to emit the machine-readable
`StoredChainVerificationResult`. Exit codes: `0` intact, `1` broken
(tampering detected), `2` the check could not run.

## 5. Load and integration testing (not performed here)

The issue doesn't specify audit-logging-specific throughput targets the
way #69 specifies "100k ops/sec" for Redis, but two things are worth
flagging as unverified:

- **Write amplification under high-frequency table changes.** Every
  audited INSERT/UPDATE/DELETE now also does one `SELECT ... ORDER BY
  sequence_num DESC LIMIT 1` (to fetch the chain tail) plus one INSERT
  into `audit_log`. Under heavy concurrent writes to the same audited
  table, this read-then-insert has a known race (documented in
  `auditLogStore.ts`'s `getLatestEntryHash` doc comment) and adds latency
  to the operation being audited — not load-tested against realistic
  write volume here.
- **`queryAuditLog` performance at scale.** Indexes exist for the common
  filter columns (`table_name, record_id`, `user_id`, `occurred_at`,
  `operation`) and pagination is `sequence_num`-based (index-friendly,
  no OFFSET), but this hasn't been benchmarked against a large
  (multi-million-row) `audit_log` table — only against the small
  in-memory fake used in unit tests.
