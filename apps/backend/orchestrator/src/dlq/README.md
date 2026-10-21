# Dead Letter Queue (DLQ) Auto-Replay & Remediation Worker

**Issue #310**

Service that monitors failed BullMQ jobs (e.g., temporary network partitions) and safely replays them after circuit breaker resets.

## Features

- **Auto-Replay**: Automatically detects and replays jobs that failed due to recoverable network errors
- **Circuit Breaker**: Prevents retry storms when target service is down
- **Manual Replay**: Admin API to manually trigger job replay
- **Deduplication**: Ensures jobs are not duplicated on replay by preserving original job IDs
- **Transaction Safety**: Prevents re-execution of completed transaction side-effects

## Database Schema

The DLQ uses the `orchestrator_dead_letter_queue` table:

```sql
CREATE TABLE orchestrator_dead_letter_queue (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  failed_reason TEXT NOT NULL,
  attempts_made INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL,
  replayed_at TIMESTAMPTZ,
  replay_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, queue_name)
);
```

## API Endpoints

### POST /api/v1/admin/dlq/replay

Manually replay failed jobs.

**Request Body:**
```json
{
  "jobIds": ["job-1", "job-2"],  // Optional: specific job IDs
  "queueName": "checkout",        // Optional: replay jobs from specific queue
  "maxRetries": 100               // Optional: max number of jobs to replay
}
```

**Response:**
```json
{
  "data": {
    "total": 10,
    "successful": 8,
    "failed": 2,
    "results": [
      {
        "success": true,
        "jobId": "job-1",
        "queueName": "checkout"
      }
    ]
  },
  "error": null
}
```

### GET /api/v1/admin/dlq/circuit-breaker/:queueName

Get circuit breaker state for a specific queue.

**Response:**
```json
{
  "data": {
    "queueName": "checkout",
    "state": "CLOSED",
    "failures": 0,
    "successes": 0,
    "lastFailureTime": null,
    "nextAttemptTime": null
  },
  "error": null
}
```

### POST /api/v1/admin/dlq/circuit-breaker/:queueName/reset

Reset circuit breaker for a specific queue.

**Response:**
```json
{
  "data": {
    "queueName": "checkout",
    "message": "Circuit breaker reset successfully"
  },
  "error": null
}
```

## Auto-Replay Cron

The DLQ service runs a periodic cron job to automatically replay jobs with recoverable network errors:

- **Interval**: Configurable via `DLQ_AUTO_REPLAY_INTERVAL_MS` (default: 5 minutes)
- **Disable**: Set `DLQ_AUTO_REPLAY_INTERVAL_MS=0` to disable auto-replay
- **Recoverable Errors**: Detects patterns like `ECONNREFUSED`, `ETIMEDOUT`, `network`, `connection`, `timeout`

## Circuit Breaker

The circuit breaker prevents retry storms when the target service is down:

### States

- **CLOSED**: Normal operation, all requests are allowed
- **OPEN**: Service is down, requests are blocked until timeout
- **HALF_OPEN**: Testing if service is back up

### Configuration

```typescript
{
  failureThreshold: 5,      // Open circuit after 5 failures
  successThreshold: 2,      // Close circuit after 2 successes in HALF_OPEN
  timeout: 60000,          // Wait 1 minute before trying again
}
```

## Environment Variables

- `DLQ_AUTO_REPLAY_INTERVAL_MS`: Auto-replay cron interval in milliseconds (default: 300000 = 5 minutes)
- `REDIS_URL`: Redis connection URL for BullMQ (default: `redis://localhost:6379`)
- `DATABASE_URL`: PostgreSQL connection string

## Usage Example

### Adding a job to the DLQ (from your application)

```typescript
import { DLQStore } from './dlq/index.js';

const dlqStore = new DLQStore(pool);

try {
  // Your job processing logic
  await processJob(job);
} catch (error) {
  // Add failed job to DLQ
  await dlqStore.addJob({
    jobId: job.id,
    queueName: 'checkout',
    failedReason: error.message,
    attemptsMade: job.attemptsMade,
    payload: job.data,
    failedAt: new Date().toISOString(),
  });
}
```

### Manual replay via API

```bash
# Replay all pending jobs
curl -X POST http://localhost:3010/api/v1/admin/dlq/replay \
  -H "Content-Type: application/json" \
  -d '{}'

# Replay specific jobs
curl -X POST http://localhost:3010/api/v1/admin/dlq/replay \
  -H "Content-Type: application/json" \
  -d '{"jobIds": ["job-1", "job-2"]}'

# Replay jobs from specific queue
curl -X POST http://localhost:3010/api/v1/admin/dlq/replay \
  -H "Content-Type: application/json" \
  -d '{"queueName": "checkout"}'
```

## Architecture

```
┌─────────────┐
│  BullMQ Job │
│   Failure   │
└──────┬──────┘
       │
       v
┌─────────────────┐
│   DLQ Store     │
│  (PostgreSQL)   │
└──────┬──────────┘
       │
       v
┌─────────────────┐      ┌──────────────────┐
│  Auto-Replay    │─────>│ Circuit Breaker  │
│     Cron        │      │  (per queue)     │
└──────┬──────────┘      └──────────────────┘
       │                           │
       │                           v
       │                    ┌─────────────┐
       │                    │   CLOSED    │
       │                    │   (allow)   │
       │                    └─────────────┘
       │                           │
       │                    ┌─────────────┐
       │                    │    OPEN     │
       │                    │   (block)   │
       │                    └─────────────┘
       │                           │
       │                    ┌─────────────┐
       │                    │ HALF_OPEN   │
       │                    │   (test)    │
       └───────────────────>└─────────────┘
                                   │
                                   v
                            ┌──────────────┐
                            │  BullMQ      │
                            │  Re-enqueue  │
                            └──────────────┘
```

## Acceptance Criteria

✅ Successfully re-enqueues jobs without duplicating completed transaction side-effects
- Uses original job IDs to prevent duplicates
- Checks if job is already completed before replay

✅ Circuit breaker prevents retry storm if target service is down
- Configurable failure threshold and timeout
- Automatic transition between CLOSED, OPEN, and HALF_OPEN states

✅ Auto-replay cron for recoverable network errors
- Periodic scanning for jobs with network-related failures
- Configurable interval and disable option

✅ Admin API endpoint for manual replay
- POST /api/v1/admin/dlq/replay
- Supports filtering by job IDs or queue name
