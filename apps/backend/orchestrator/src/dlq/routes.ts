/**
 * DLQ API Routes
 * Issue #310
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, route } from '@delegolabs/utils';
import type { DLQService } from './service.js';
import type { ReplayRequest } from './types.js';

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const MAX_BODY_SIZE = 1_048_576; // 1MB

    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_SIZE) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('JSON body must be an object');
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

export function createDLQRoutes(dlqService: DLQService) {
  return [
    /**
     * GET /api/v1/admin/dlq/jobs
     * List DLQ records, including full stack traces and cause chains, so
     * engineers can inspect complete diagnostic context from the DLQ viewer
     * (Issue #347). Supports optional ?status= and ?queueName= filters.
     */
    route('GET', '/api/v1/admin/dlq/jobs', async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '', 'http://internal');
      const status = url.searchParams.get('status') ?? undefined;
      const queueName = url.searchParams.get('queueName') ?? undefined;
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? Number(limitParam) : undefined;

      const rows = await dlqService.listJobs({ status, queueName, limit });

      json(res, 200, {
        data: rows.map((row) => ({
          jobId: row.job_id,
          queueName: row.queue_name,
          failedReason: row.failed_reason,
          stackTrace: row.stack_trace ?? '',
          errorCauseChain: row.error_cause_chain ?? [],
          attemptsMade: row.attempts_made,
          payload: row.payload,
          failedAt: row.failed_at,
          replayedAt: row.replayed_at,
          replayCount: row.replay_count,
          status: row.status,
        })),
        error: null,
      });
    }),

    /**
     * GET /api/v1/admin/dlq/jobs/:queueName/:jobId
     * Fetch a single DLQ record's full diagnostic detail, including its
     * complete stack trace (Issue #347).
     */
    route('GET', '/api/v1/admin/dlq/jobs/:queueName/:jobId', async (_req: IncomingMessage, res: ServerResponse, params?: Record<string, string>) => {
      const { queueName, jobId } = params ?? {};
      if (!queueName || !jobId) {
        json(res, 400, {
          data: null,
          error: { code: 'VALIDATION_ERROR', message: 'queueName and jobId are required' },
        });
        return;
      }

      const row = await dlqService.getJobDetail(jobId, queueName);
      if (!row) {
        json(res, 404, {
          data: null,
          error: { code: 'NOT_FOUND', message: `DLQ record not found for ${queueName}/${jobId}` },
        });
        return;
      }

      json(res, 200, {
        data: {
          jobId: row.job_id,
          queueName: row.queue_name,
          failedReason: row.failed_reason,
          stackTrace: row.stack_trace ?? '',
          errorCauseChain: row.error_cause_chain ?? [],
          attemptsMade: row.attempts_made,
          payload: row.payload,
          failedAt: row.failed_at,
          replayedAt: row.replayed_at,
          replayCount: row.replay_count,
          status: row.status,
        },
        error: null,
      });
    }),

    /**
     * POST /api/v1/admin/dlq/replay
     * Manually replay failed jobs
     */
    route('POST', '/api/v1/admin/dlq/replay', async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const body = await readJsonBody(req);
        const request = body as ReplayRequest;

        const results = await dlqService.replayJobs(request);

        json(res, 200, {
          data: {
            total: results.length,
            successful: results.filter((r) => r.success).length,
            failed: results.filter((r) => !r.success).length,
            results,
          },
          error: null,
        });
      } catch (error) {
        json(res, 500, {
          data: null,
          error: {
            code: 'DLQ_REPLAY_FAILED',
            message: error instanceof Error ? error.message : 'Failed to replay jobs',
          },
        });
      }
    }),

    /**
     * GET /api/v1/admin/dlq/circuit-breaker/:queueName
     * Get circuit breaker state for a queue
     */
    route('GET', '/api/v1/admin/dlq/circuit-breaker/:queueName', async (_req: IncomingMessage, res: ServerResponse, params?: Record<string, string>) => {
      const queueName = params?.queueName;
      if (!queueName) {
        json(res, 400, {
          data: null,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'queueName is required',
          },
        });
        return;
      }

      const state = dlqService.getCircuitBreakerState(queueName);

      if (!state) {
        json(res, 404, {
          data: null,
          error: {
            code: 'NOT_FOUND',
            message: `Circuit breaker not found for queue: ${queueName}`,
          },
        });
        return;
      }

      json(res, 200, {
        data: { queueName, ...state },
        error: null,
      });
    }),

    /**
     * POST /api/v1/admin/dlq/circuit-breaker/:queueName/reset
     * Reset circuit breaker for a queue
     */
    route('POST', '/api/v1/admin/dlq/circuit-breaker/:queueName/reset', async (_req: IncomingMessage, res: ServerResponse, params?: Record<string, string>) => {
      const queueName = params?.queueName;
      if (!queueName) {
        json(res, 400, {
          data: null,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'queueName is required',
          },
        });
        return;
      }

      dlqService.resetCircuitBreaker(queueName);

      json(res, 200, {
        data: { queueName, message: 'Circuit breaker reset successfully' },
        error: null,
      });
    }),
  ];
}
