/**
 * Persistence for granular webhook delivery forensic logs
 * (migration `20261020_webhook_delivery_forensic_logs`).
 *
 * One row per delivery attempt so merchant integrations can answer "what did
 * you send me, when, and what did we answer?" — the request payload is stored
 * as a SHA-256 digest (never the raw body), the response as a status code plus
 * a truncated body sample and the measured latency.
 */

import { createHash } from "node:crypto";
import { createLogger } from "@delegolabs/utils";
import type { Pool } from "pg";

const log = createLogger("notifications:webhooks:deliveryLogStore", process.env.LOG_LEVEL ?? "info");

export interface WebhookDeliveryLog {
  id: string;
  endpointId: string;
  eventType: string;
  /** SHA-256 hex digest (64 chars) of the raw request payload. */
  payloadHash: string;
  attemptNumber: number;
  /** HTTP response status, or null when no response arrived (timeout, abort). */
  httpStatus: number | null;
  latencyMs: number | null;
  responseBodySample: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface RecordDeliveryAttemptInput {
  endpointId: string;
  eventType: string;
  /** Raw signed request body — hashed before it reaches the database. */
  payload: string | Buffer;
  /** 1-based attempt counter; defaults to 1 on the first send. */
  attemptNumber?: number;
  httpStatus?: number | null;
  latencyMs?: number | null;
  responseBodySample?: string | null;
  errorMessage?: string | null;
}

interface DeliveryLogRow {
  id: string;
  endpoint_id: string;
  event_type: string;
  payload_hash: string;
  attempt_number: number;
  http_status: number | null;
  latency_ms: number | null;
  response_body_sample: string | null;
  error_message: string | null;
  created_at: Date;
}

const COLUMNS =
  "id, endpoint_id, event_type, payload_hash, attempt_number, http_status, latency_ms, response_body_sample, error_message, created_at";

/** Hex SHA-256 digest matching the CHAR(64) `payload_hash` column. */
export function computePayloadHash(payload: string | Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

function toDeliveryLog(row: DeliveryLogRow): WebhookDeliveryLog {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventType: row.event_type,
    payloadHash: row.payload_hash,
    attemptNumber: Number(row.attempt_number),
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    responseBodySample: row.response_body_sample,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

export class WebhookDeliveryLogStore {
  constructor(private readonly db: Pool) {}

  /** Insert one delivery attempt and return the stored row. */
  async recordAttempt(input: RecordDeliveryAttemptInput): Promise<WebhookDeliveryLog> {
    const result = await this.db.query(
      `INSERT INTO webhook_delivery_logs (
         endpoint_id, event_type, payload_hash, attempt_number,
         http_status, latency_ms, response_body_sample, error_message
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLUMNS}`,
      [
        input.endpointId,
        input.eventType,
        computePayloadHash(input.payload),
        input.attemptNumber ?? 1,
        input.httpStatus ?? null,
        input.latencyMs ?? null,
        input.responseBodySample ?? null,
        input.errorMessage ?? null,
      ],
    );

    const entry = toDeliveryLog(result.rows[0] as DeliveryLogRow);
    log.info("Webhook delivery attempt logged", {
      id: entry.id,
      endpointId: entry.endpointId,
      eventType: entry.eventType,
      attemptNumber: entry.attemptNumber,
      httpStatus: entry.httpStatus,
    });
    return entry;
  }
}
