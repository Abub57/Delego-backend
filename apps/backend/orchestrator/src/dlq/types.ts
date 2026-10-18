/**
 * Dead Letter Queue (DLQ) types for BullMQ job replay
 * Issue #310
 */

export interface DeadLetterJobRecord {
  jobId: string;
  queueName: string;
  failedReason: string;
  /** Full `error.stack` captured at the moment the job was moved to the DLQ (Issue #347). */
  stackTrace: string;
  /** Formatted `error.cause` chain, outermost cause first (Issue #347). */
  errorCauseChain: string[];
  attemptsMade: number;
  payload: Record<string, unknown>;
  failedAt: string;
}

export interface DLQJobRow {
  id: string;
  job_id: string;
  queue_name: string;
  failed_reason: string;
  stack_trace: string | null;
  error_cause_chain: string[] | null;
  attempts_made: number;
  payload: Record<string, unknown>;
  failed_at: Date;
  replayed_at: Date | null;
  replay_count: number;
  status: 'pending' | 'replaying' | 'replayed' | 'failed';
  created_at: Date;
  updated_at: Date;
}

/**
 * DLQ record shape exposed over the management REST API (Issue #347).
 * Mirrors `DeadLetterJobRecord` but keeps the generic `data` naming used by
 * API consumers and drops internal-only fields.
 */
export interface DlqRecord<T = unknown> {
  jobId: string;
  queueName: string;
  data: T;
  failedReason: string;
  stackTrace: string;
  errorCauseChain: string[];
  failedAt: Date;
  attemptsMade: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
}

export interface CircuitBreakerState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  nextAttemptTime: number | null;
}

export interface ReplayResult {
  success: boolean;
  jobId: string;
  queueName: string;
  error?: string;
}

export interface ReplayRequest {
  jobIds?: string[];
  queueName?: string;
  maxRetries?: number;
}
