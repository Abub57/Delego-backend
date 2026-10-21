/**
 * Dead Letter Queue (DLQ) Triage Types
 * Issue #363
 */

export interface DlqTriagePolicy {
  transientErrorPatterns: string[];
  maxAutomaticRetries: number;
  slackWebhookUrl: string;
}

export type TriageDecision = "retry_now" | "schedule_retry" | "quarantine" | "discard";

export interface DlqTriageJobData {
  jobId: string;
  queueName?: string;
  errorMessage: string;
  errorCode?: string;
  errorStack?: string;
  failedAt: string | number;
  retryCount: number;
  payload: unknown;
  metadata?: Record<string, unknown>;
}

export interface DlqTriageResult {
  jobId: string;
  decision: TriageDecision;
  reason: string;
  retryCount: number;
  nextRetryDelayMs?: number;
  nextRetryAt?: string;
  alertSent?: boolean;
  quarantinedAt?: string;
}

export interface SlackAlertPayload {
  channel?: string;
  text: string;
  blocks?: Array<Record<string, unknown>>;
  attachments?: Array<Record<string, unknown>>;
}
