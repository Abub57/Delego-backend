/**
 * Dispute persistence (Issue #46).
 *
 * Postgres-backed in production (`disputes` / `dispute_evidence` tables from
 * migration 016); an in-memory implementation is the default so unit tests
 * (and local dev without a database) can exercise the mediation workflow
 * directly. Swap backends via {@link setDisputeStore} /
 * {@link enablePostgresDisputeStore}.
 */

import { createHash, randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { createLogger } from "@delegolabs/utils";
import type { Dispute, DisputeEvidenceEntry, DisputeResolution, DisputeStatus, DisputeTier } from "./types.js";

const log = createLogger("payments:disputes:store", process.env.LOG_LEVEL ?? "info");

export interface CreateDisputeInput {
  escrowId: string;
  orderId?: string;
  initiatedBy: string;
  reason: string;
  slaDeadline: string;
}

export interface DisputeUpdate {
  status?: DisputeStatus;
  mediator?: string;
  resolution?: DisputeResolution;
  resolutionError?: string | null;
  escalatedAt?: string;
  escalationTier?: DisputeTier;
  escalationEscalatedAt?: string;
}

export interface DisputeStore {
  create(input: CreateDisputeInput): Promise<Dispute>;
  findById(id: string): Promise<Dispute | null>;
  findByEscrowId(escrowId: string): Promise<Dispute[]>;
  update(id: string, update: DisputeUpdate): Promise<Dispute>;
  addEvidence(disputeId: string, entry: DisputeEvidenceEntry): Promise<Dispute>;
  /** Open/in-progress disputes whose SLA deadline has passed and haven't been escalated yet. */
  findBreached(now: Date): Promise<Dispute[]>;
  /** Active disputes open for longer than `stalledHours` that aren't yet at the `senior` tier. */
  findStalled(now: Date, stalledHours: number): Promise<Dispute[]>;
}

// ---------------------------------------------------------------------------
// In-memory backend (default; used in tests and local dev)
// ---------------------------------------------------------------------------

export class InMemoryDisputeStore implements DisputeStore {
  private readonly disputes = new Map<string, Dispute>();
  private readonly escalated = new Set<string>();

  async create(input: CreateDisputeInput): Promise<Dispute> {
    const now = new Date().toISOString();
    const dispute: Dispute = {
      id: randomUUID(),
      escrowId: input.escrowId,
      initiatedBy: input.initiatedBy,
      reason: input.reason,
      evidence: [],
      status: "open",
      createdAt: now,
      updatedAt: now,
      slaDeadline: input.slaDeadline,
    };
    this.disputes.set(dispute.id, dispute);
    return { ...dispute };
  }

  async findById(id: string): Promise<Dispute | null> {
    const dispute = this.disputes.get(id);
    return dispute ? { ...dispute, evidence: [...dispute.evidence] } : null;
  }

  async findByEscrowId(escrowId: string): Promise<Dispute[]> {
    return Array.from(this.disputes.values())
      .filter((d) => d.escrowId === escrowId)
      .map((d) => ({ ...d, evidence: [...d.evidence] }));
  }

  async update(id: string, update: DisputeUpdate): Promise<Dispute> {
    const existing = this.disputes.get(id);
    if (!existing) throw new Error(`Dispute not found: ${id}`);

    const updated: Dispute = {
      ...existing,
      status: update.status ?? existing.status,
      mediator: update.mediator ?? existing.mediator,
      resolution: update.resolution ?? existing.resolution,
      escalationTier: update.escalationTier ?? existing.escalationTier,
      escalationEscalatedAt:
        update.escalationEscalatedAt ?? existing.escalationEscalatedAt,
      updatedAt: new Date().toISOString(),
    };
    this.disputes.set(id, updated);
    if (update.escalatedAt !== undefined) {
      this.escalated.add(id);
    }
    return { ...updated };
  }

  async addEvidence(disputeId: string, entry: DisputeEvidenceEntry): Promise<Dispute> {
    const existing = this.disputes.get(disputeId);
    if (!existing) throw new Error(`Dispute not found: ${disputeId}`);

    const updated: Dispute = {
      ...existing,
      evidence: [...existing.evidence, entry],
      updatedAt: new Date().toISOString(),
    };
    this.disputes.set(disputeId, updated);
    return { ...updated, evidence: [...updated.evidence] };
  }

  async findBreached(now: Date): Promise<Dispute[]> {
    return Array.from(this.disputes.values())
      .filter(
        (d) =>
          d.status !== "decided" &&
          d.status !== "resolved" &&
          new Date(d.slaDeadline).getTime() <= now.getTime() &&
          !this.escalated.has(d.id)
      )
      .map((d) => ({ ...d, evidence: [...d.evidence] }));
  }

  async findStalled(now: Date, stalledHours: number): Promise<Dispute[]> {
    const cutoff = now.getTime() - stalledHours * 60 * 60 * 1000;
    return Array.from(this.disputes.values())
      .filter(
        (d) =>
          d.status !== "decided" &&
          d.status !== "resolved" &&
          new Date(d.createdAt).getTime() <= cutoff &&
          (d.escalationTier === undefined || d.escalationTier === "tier1")
      )
      .map((d) => ({ ...d, evidence: [...d.evidence] }));
  }
}

// ---------------------------------------------------------------------------
// Postgres backend (production)
// ---------------------------------------------------------------------------

interface DisputeRow extends QueryResultRow {
  id: string;
  escrow_id: string;
  initiated_by: string;
  reason: string;
  mediator: string | null;
  status: DisputeStatus;
  sla_deadline: Date;
  escalated_at: Date | null;
  escalation_tier: DisputeTier | null;
  escalation_escalated_at: Date | null;
  resolution_type: DisputeResolution["type"] | null;
  resolution_buyer_amount: string | null;
  resolution_seller_amount: string | null;
  resolution_decided_by: string | null;
  resolution_decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface EvidenceRow extends QueryResultRow {
  party: string;
  description: string;
  files: string[];
  submitted_at: Date;
}

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";
    pool = new Pool({ connectionString: databaseUrl });
  }
  return pool;
}

export function _setPoolForTesting(testPool: Pool): void {
  pool = testPool;
}

export function _resetPoolForTesting(): void {
  pool = null;
}

async function mapDisputeRow(row: DisputeRow, client: Pool): Promise<Dispute> {
  const { rows: evidenceRows } = await client.query<EvidenceRow>(
    `SELECT party, description, files, submitted_at
     FROM dispute_evidence
     WHERE dispute_id = $1
     ORDER BY submitted_at ASC`,
    [row.id]
  );

  const dispute: Dispute = {
    id: row.id,
    escrowId: row.escrow_id,
    initiatedBy: row.initiated_by,
    reason: row.reason,
    evidence: evidenceRows.map((e) => ({
      party: e.party,
      description: e.description,
      files: e.files,
      submittedAt: e.submitted_at.toISOString(),
    })),
    mediator: row.mediator ?? undefined,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    slaDeadline: row.sla_deadline.toISOString(),
    escalationTier: row.escalation_tier ?? undefined,
    escalationEscalatedAt: row.escalation_escalated_at?.toISOString(),
  };

  if (row.resolution_type) {
    dispute.resolution = {
      type: row.resolution_type,
      buyerAmount: row.resolution_buyer_amount ?? "0",
      sellerAmount: row.resolution_seller_amount ?? "0",
      decidedBy: row.resolution_decided_by ?? "",
      decidedAt: row.resolution_decided_at?.toISOString() ?? "",
    };
  }

  return dispute;
}

export class PostgresDisputeStore implements DisputeStore {
  async create(input: CreateDisputeInput): Promise<Dispute> {
    const client = getPool();
    const { rows } = await client.query<DisputeRow>(
      `INSERT INTO disputes (escrow_id, order_id, initiated_by, reason, status, sla_deadline)
       VALUES ($1, $2, $3, $4, 'open', $5)
       RETURNING *`,
      [input.escrowId, input.orderId ?? null, input.initiatedBy, input.reason, input.slaDeadline]
    );
    log.info("Dispute created", { id: rows[0].id, escrowId: input.escrowId });
    return mapDisputeRow(rows[0], client);
  }

  async findById(id: string): Promise<Dispute | null> {
    const client = getPool();
    const { rows } = await client.query<DisputeRow>(`SELECT * FROM disputes WHERE id = $1`, [id]);
    return rows[0] ? mapDisputeRow(rows[0], client) : null;
  }

  async findByEscrowId(escrowId: string): Promise<Dispute[]> {
    const client = getPool();
    const { rows } = await client.query<DisputeRow>(
      `SELECT * FROM disputes WHERE escrow_id = $1 ORDER BY created_at DESC`,
      [escrowId]
    );
    return Promise.all(rows.map((r) => mapDisputeRow(r, client)));
  }

  async update(id: string, update: DisputeUpdate): Promise<Dispute> {
    const client = getPool();
    const fields: string[] = [];
    const values: unknown[] = [id];

    const addField = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (update.status !== undefined) addField("status", update.status);
    if (update.mediator !== undefined) addField("mediator", update.mediator);
    if (update.escalatedAt !== undefined) addField("escalated_at", update.escalatedAt);
    if (update.escalationTier !== undefined) addField("escalation_tier", update.escalationTier);
    if (update.escalationEscalatedAt !== undefined) {
      addField("escalation_escalated_at", update.escalationEscalatedAt);
    }
    if (update.resolutionError !== undefined) addField("resolution_error", update.resolutionError);
    if (update.resolution !== undefined) {
      addField("resolution_type", update.resolution.type);
      addField("resolution_buyer_amount", update.resolution.buyerAmount);
      addField("resolution_seller_amount", update.resolution.sellerAmount);
      addField("resolution_decided_by", update.resolution.decidedBy);
      addField("resolution_decided_at", update.resolution.decidedAt);
    }

    if (fields.length > 0) {
      fields.push("updated_at = NOW()");
      const { rows } = await client.query<DisputeRow>(
        `UPDATE disputes SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
        values
      );
      if (!rows[0]) throw new Error(`Dispute not found: ${id}`);
      return mapDisputeRow(rows[0], client);
    }

    const { rows } = await client.query<DisputeRow>(`SELECT * FROM disputes WHERE id = $1`, [id]);
    if (!rows[0]) throw new Error(`Dispute not found: ${id}`);
    return mapDisputeRow(rows[0], client);
  }

  async addEvidence(disputeId: string, entry: DisputeEvidenceEntry): Promise<Dispute> {
    const client = getPool();
    // Lightweight tamper-evidence checksum over the submitted evidence
    // reference (we can't fetch/verify IPFS content server-side, so this
    // only proves the stored row matches what was originally submitted).
    const integrityHash = createHash("sha256")
      .update(JSON.stringify({ party: entry.party, description: entry.description, files: entry.files }))
      .digest("hex");

    await client.query(
      `INSERT INTO dispute_evidence (dispute_id, party, description, files, integrity_hash, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [disputeId, entry.party, entry.description, JSON.stringify(entry.files), integrityHash, entry.submittedAt]
    );
    await client.query(`UPDATE disputes SET updated_at = NOW() WHERE id = $1`, [disputeId]);

    const { rows } = await client.query<DisputeRow>(`SELECT * FROM disputes WHERE id = $1`, [disputeId]);
    if (!rows[0]) throw new Error(`Dispute not found: ${disputeId}`);
    return mapDisputeRow(rows[0], client);
  }

  async findBreached(now: Date): Promise<Dispute[]> {
    const client = getPool();
    const { rows } = await client.query<DisputeRow>(
      `SELECT * FROM disputes
       WHERE status NOT IN ('decided', 'resolved')
       AND sla_deadline <= $1
       AND escalated_at IS NULL`,
      [now]
    );
    return Promise.all(rows.map((r) => mapDisputeRow(r, client)));
  }

  async findStalled(now: Date, stalledHours: number): Promise<Dispute[]> {
    const client = getPool();
    const cutoff = new Date(now.getTime() - stalledHours * 60 * 60 * 1000);
    const { rows } = await client.query<DisputeRow>(
      `SELECT * FROM disputes
       WHERE status NOT IN ('decided', 'resolved')
       AND created_at <= $1
       AND (escalation_tier IS NULL OR escalation_tier = 'tier1')`,
      [cutoff]
    );
    return Promise.all(rows.map((r) => mapDisputeRow(r, client)));
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let store: DisputeStore = new InMemoryDisputeStore();

export function setDisputeStore(newStore: DisputeStore): void {
  store = newStore;
}

export function resetDisputeStore(): void {
  store = new InMemoryDisputeStore();
}

export function enablePostgresDisputeStore(): void {
  store = new PostgresDisputeStore();
  log.info("Dispute store switched to PostgreSQL backend");
}

export function getDisputeStore(): DisputeStore {
  return store;
}
