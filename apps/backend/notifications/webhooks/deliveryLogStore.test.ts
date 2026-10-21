import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { computePayloadHash, WebhookDeliveryLogStore } from "./deliveryLogStore.js";

// ---------------------------------------------------------------------------
// In-memory stand-in for `webhook_delivery_logs` that understands exactly the
// INSERT issued by WebhookDeliveryLogStore and applies the column defaults.
// ---------------------------------------------------------------------------

interface Row {
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

class FakeDb {
  rows: Row[] = [];
  /** Every statement the store issued, so tests can assert on the raw params. */
  statements: { sql: string; params: unknown[] }[] = [];
  private seq = 0;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    if (!/^INSERT INTO webhook_delivery_logs/.test(sql)) {
      throw new Error(`FakeDb: unexpected SQL: ${sql}`);
    }
    this.statements.push({ sql, params });

    const row: Row = {
      id: `log-${++this.seq}`,
      endpoint_id: params[0] as string,
      event_type: params[1] as string,
      payload_hash: params[2] as string,
      attempt_number: params[3] as number,
      http_status: params[4] as number | null,
      latency_ms: params[5] as number | null,
      response_body_sample: params[6] as string | null,
      error_message: params[7] as string | null,
      created_at: new Date(),
    };
    this.rows.push(row);
    return { rows: [{ ...row }] };
  }
}

function makeStore() {
  const db = new FakeDb();
  return { db, store: new WebhookDeliveryLogStore(db as unknown as Pool) };
}

const ENDPOINT_ID = "3f1c0f9e-2c2a-4f1b-9c1e-6a0d2b7e5a10";
const PAYLOAD = JSON.stringify({ event: "order.created", data: { id: 42 } });

describe("computePayloadHash", () => {
  it("returns the SHA-256 hex digest of the raw payload", () => {
    const expected = createHash("sha256").update(PAYLOAD, "utf8").digest("hex");
    expect(computePayloadHash(PAYLOAD)).toBe(expected);
  });

  it("is 64 lowercase hex characters, matching the CHAR(64) column", () => {
    expect(computePayloadHash(PAYLOAD)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic and payload-sensitive", () => {
    expect(computePayloadHash(PAYLOAD)).toBe(computePayloadHash(PAYLOAD));
    expect(computePayloadHash(PAYLOAD)).not.toBe(computePayloadHash(`${PAYLOAD} `));
  });

  it("hashes Buffer bodies identically to their string form", () => {
    expect(computePayloadHash(Buffer.from(PAYLOAD, "utf8"))).toBe(computePayloadHash(PAYLOAD));
  });
});

describe("WebhookDeliveryLogStore.recordAttempt", () => {
  it("inserts one row and returns the stored attempt", async () => {
    const { db, store } = makeStore();

    const entry = await store.recordAttempt({
      endpointId: ENDPOINT_ID,
      eventType: "order.created",
      payload: PAYLOAD,
    });

    expect(db.rows).toHaveLength(1);
    expect(entry).toMatchObject({
      id: "log-1",
      endpointId: ENDPOINT_ID,
      eventType: "order.created",
      payloadHash: createHash("sha256").update(PAYLOAD, "utf8").digest("hex"),
    });
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it("defaults attemptNumber to 1 and leaves response fields null", async () => {
    const { db, store } = makeStore();

    const entry = await store.recordAttempt({
      endpointId: ENDPOINT_ID,
      eventType: "order.created",
      payload: PAYLOAD,
    });

    expect(entry.attemptNumber).toBe(1);
    expect(entry.httpStatus).toBeNull();
    expect(entry.latencyMs).toBeNull();
    expect(entry.responseBodySample).toBeNull();
    expect(entry.errorMessage).toBeNull();
    expect(db.rows[0].attempt_number).toBe(1);
  });

  it("stores the payload as a SHA-256 hash and never the raw body", async () => {
    const { db, store } = makeStore();

    await store.recordAttempt({
      endpointId: ENDPOINT_ID,
      eventType: "order.created",
      payload: PAYLOAD,
    });

    const { params } = db.statements[0];
    expect(params[2]).toBe(computePayloadHash(PAYLOAD));
    expect(params).not.toContain(PAYLOAD);
    expect(String(params[2])).toHaveLength(64);
  });

  it("records HTTP status, latency, body sample and error for a failed response", async () => {
    const { db, store } = makeStore();

    const entry = await store.recordAttempt({
      endpointId: ENDPOINT_ID,
      eventType: "escrow.released",
      payload: PAYLOAD,
      attemptNumber: 3,
      httpStatus: 503,
      latencyMs: 1842,
      responseBodySample: '{"error":"service unavailable"}',
      errorMessage: "upstream returned 503",
    });

    expect(entry).toMatchObject({
      attemptNumber: 3,
      httpStatus: 503,
      latencyMs: 1842,
      responseBodySample: '{"error":"service unavailable"}',
      errorMessage: "upstream returned 503",
    });
    // Column order matches the INSERT's parameter list.
    expect(db.rows[0]).toMatchObject({
      attempt_number: 3,
      http_status: 503,
      latency_ms: 1842,
      response_body_sample: '{"error":"service unavailable"}',
      error_message: "upstream returned 503",
    });
  });

  it("records a null status for attempts that got no response at all", async () => {
    const { db, store } = makeStore();

    const entry = await store.recordAttempt({
      endpointId: ENDPOINT_ID,
      eventType: "dispute.opened",
      payload: PAYLOAD,
      attemptNumber: 2,
      errorMessage: "ETIMEDOUT after 10000ms",
    });

    expect(entry.httpStatus).toBeNull();
    expect(db.rows[0].http_status).toBeNull();
    expect(db.rows[0].error_message).toBe("ETIMEDOUT after 10000ms");
  });

  it("logs each retry of the same payload as a separate attempt", async () => {
    const { db, store } = makeStore();

    await store.recordAttempt({ endpointId: ENDPOINT_ID, eventType: "order.created", payload: PAYLOAD });
    await store.recordAttempt({
      endpointId: ENDPOINT_ID,
      eventType: "order.created",
      payload: PAYLOAD,
      attemptNumber: 2,
      httpStatus: 500,
    });

    expect(db.rows).toHaveLength(2);
    expect(db.rows.map((r) => r.attempt_number)).toEqual([1, 2]);
    // Same payload → same digest, so retries are correlatable.
    expect(db.rows[0].payload_hash).toBe(db.rows[1].payload_hash);
  });
});
