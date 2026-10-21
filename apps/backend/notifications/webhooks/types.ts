/**
 * Outbound webhook management types (Issue #102, #381).
 */

export type WebhookStatus = "active" | "paused" | "disabled";
export type FilterOperator = "eq" | "neq" | "contains" | "gt" | "lt";

export interface WebhookFilter {
  field: string;
  operator: FilterOperator;
  value: unknown;
}

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export interface Webhook {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: string[];
  filters: WebhookFilter[];
  headers: Record<string, string>;
  retryPolicy: RetryPolicy;
  status: WebhookStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryStatus = "pending" | "delivered" | "failed" | "dead_letter";

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  attempt: number;
  status: DeliveryStatus;
  responseStatus?: number;
  responseBody?: string;
  error?: string;
  nextRetryAt?: string | null;
  sentAt: string;
  completedAt?: string;
}

export interface WebhookMetrics {
  webhookId: string;
  totalDeliveries: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  deadLetterCount: number;
  avgLatencyMs: number;
  lastDeliveryAt: string | null;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
};

/** 48-hour grace period during which both the old and new secrets are valid (Issue #381). */
export const ROTATION_GRACE_PERIOD_MS = 48 * 60 * 60 * 1000;

/**
 * Tracks the current and (during rotation) previous webhook secret together
 * with the deadline after which the previous secret is discarded (Issue #381).
 */
export interface SecretRotationState {
  currentSecret: string;
  previousSecret?: string;
  rotationDeadline?: Date;
}
