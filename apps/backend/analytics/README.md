# @delegolabs/analytics

Notification analytics platform with delivery tracking, engagement metrics, and A/B testing.

## Features

- **Delivery Funnel Tracking**: Track notifications from sent → delivered → opened → clicked → converted
- **Engagement Metrics**: Per-template/channel analytics with time-to-open, time-to-click, repeat behavior
- **A/B Testing**: Statistical significance testing with confidence intervals
- **Cohort Analysis**: Weekly cohort retention and engagement tracking
- **Real-time Dashboard**: Low-latency analytics queries
- **Revenue Attribution**: Link notification clicks to revenue events
- **Custom Events**: Track custom engagement events
- **Data Export**: Export to data warehouse for advanced analysis

## Installation

```bash
cd apps/backend/analytics
npm install
```

## Usage

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

## API Endpoints

### Spend Summary (#306)

`GET /api/v1/analytics/spend-summary` requires a Bearer token and always uses
the authenticated user's ID (a supplied `userId` cannot select another user).

| Parameter | Meaning |
| --- | --- |
| `granularity` | `daily` (default) or `monthly` |
| `periodStart` | Inclusive UTC `YYYY-MM-DD` date |
| `periodEnd` | Exclusive UTC `YYYY-MM-DD` date; range must be positive and at most 366 days |
| `category` | Optional exact merchant category, 1-64 characters |

Daily requests default to the last 30 UTC dates including today. Monthly
requests default to the current month; explicit monthly boundaries must be
first-of-month dates. Missing buckets are omitted (no spend returns `rows: []`).

```json
{
  "data": {
    "granularity": "daily",
    "periodStart": "2026-01-01",
    "periodEnd": "2026-02-01",
    "rows": [
      { "date": "2026-01-10", "category": "food", "totalSpentStroops": "12000000", "ordersCount": 2 }
    ]
  },
  "error": null
}
```

Apply the root SQL migrations (`pnpm db:migrate`) before starting analytics.
The worker in `src/metrics/aggregator.ts` refreshes at startup and every hour.
It aggregates `payment_records` in terminal `released` status, joining orders
for user ownership and merchants for category. The existing `updated_at` is
the settlement timestamp; UTC determines the day/month. Missing merchants or
empty categories use `uncategorized`. Amounts are escrow stroops minus refunded
stroops, returned as decimal strings without JavaScript precision loss. This
is a raw-stroop summary, not an FX-converted valuation across token contracts.
Pending, failed, refunded and partially settled escrows are excluded.

Each refresh scans released payment history into a temporary daily snapshot,
then replaces both summaries in one transaction. Full recomputation includes
late settlements and historical corrections without double-counting on retries.
Merchant category changes reclassify history on the next refresh. A database
advisory transaction lock serializes replicas; the scheduler skips overlapping
ticks and waits for its active refresh during SIGINT/SIGTERM shutdown.
Readers retain the last committed snapshot on failure and during refresh.
Freshness is normally up to one hour; failed runs log an error and retry on
the next tick. Before the first successful refresh the summaries are empty.

Dashboard reads touch only summary tables with user/date covering indexes.
Refresh cost scales with released history and summary size, so monitor refresh
duration and PostgreSQL autovacuum as history grows. Refreshes do not perform FX
conversion or read the separate CDC `escrows` archive.

Run the PostgreSQL regression tests against a disposable/local database:

```bash
SPEND_METRICS_TEST_DATABASE_URL=postgresql://delego:delego@localhost:5432/delego \
  pnpm --filter @delegolabs/analytics test
```

Tests create/drop their own schema and apply the actual baseline plus relevant
migrations. Without that variable, database tests are explicitly skipped.
Set `SPEND_METRICS_BENCHMARK=true` as well to seed one million released escrows
and compare a raw dashboard aggregation with 30 summary query samples. The
opt-in benchmark asserts summary p95 below 20 ms and prints timings; hardware,
network latency and workload affect results. It measures the database access
path, not end-to-end HTTP latency.

### Funnel Metrics
- `GET /api/v1/analytics/funnel` - Get delivery funnel metrics
- `GET /api/v1/analytics/engagement` - Get engagement metrics

### A/B Tests
- `GET /api/v1/analytics/ab-tests` - List A/B tests
- `POST /api/v1/analytics/ab-tests` - Create A/B test
- `GET /api/v1/analytics/ab-tests/:id` - Get A/B test details
- `PATCH /api/v1/analytics/ab-tests/:id` - Update A/B test
- `POST /api/v1/analytics/ab-tests/:id/start` - Start A/B test
- `POST /api/v1/analytics/ab-tests/:id/end` - End A/B test

### Cohort Analysis
- `GET /api/v1/analytics/cohorts` - Get cohort analysis

### Custom Events
- `POST /api/v1/analytics/events` - Track custom events

### Revenue Attribution
- `GET /api/v1/analytics/revenue` - Get revenue metrics

### Data Export
- `POST /api/v1/analytics/export` - Export data to warehouse
- `GET /api/v1/analytics/export/transactions.csv` - Stream transaction history as CSV (memory-efficient chunked export, Issue #395)

  Query params (all optional): `userId`, `templateId`, `channel`, `eventType`, `periodStart`, `periodEnd`, `pageSize` (default 1000, max 5000), `maxRows`.

  Rows are read from the database with keyset pagination (`ORDER BY id`, one page at a time) and serialized on the fly with `stream.pipeline`, so HTTP backpressure throttles DB reads and memory stays flat even for 100,000+ row exports. Output is RFC 4180-compliant CSV (CRLF terminators, quoting/escaping per spec).

## Database Schema

### notification_events
- Tracks all notification events (sent, delivered, opened, clicked, converted, etc.)
- Indexed by notification_id, user_id, template_id, channel, event_type, timestamp

### ab_tests
- Stores A/B test configurations
- Status: draft, running, completed, archived

### ab_test_variants
- Stores variant configurations for A/B tests
- Links to templates and traffic split percentages

### cohort_analyses
- Weekly cohort retention and engagement tracking
- Tracks retention, engagement rate, and revenue per user

### revenue_attributions
- Links revenue events to notification events
- Tracks order_id, amount, currency, and category

### custom_events
- Tracks custom engagement events
- Supports user_id, session_id, event_name, properties, metadata

### data_export_logs
- Logs data export requests
- Tracks status, destination, and file location

## Development

### Running Migrations

```bash
# Using sequelize-cli
npx sequelize-cli db:migrate
```

### Running Tests

```bash
npm test
```

### Type Checking

```bash
npm run typecheck
```

## Configuration

```env
# Database
DATABASE_URL=postgresql://delego:delego@localhost:5432/delego

# Service
NODE_ENV=development
LOG_LEVEL=info
ANALYTICS_PORT=3012
```
