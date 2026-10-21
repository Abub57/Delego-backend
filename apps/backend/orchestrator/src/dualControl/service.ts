// Issue #303 — Multi-party dual-control quorum enforcement.
//
// Enterprise team accounts can require M-of-N sign-off before an order goes
// through. An approval request is created for the order with the number of
// signatures it needs; team members then sign it. Rules:
//
//   - the user who created the request cannot sign it;
//   - each user can sign a request once;
//   - the order moves to "approved" only when the signature count reaches
//     `required_signatures`, and never before.
//
// Each signature is recorded in one transaction that first locks the approval
// row (SELECT … FOR UPDATE), so concurrent signers are counted one at a time
// and the quorum can't be missed or double-counted.

import type { Pool, PoolClient } from "pg";
import { createLogger } from "@delegolabs/utils";

const logger = createLogger("orchestrator:dual-control");

export type DualControlStatus = "pending" | "approved";

export interface DualControlApproval {
  id: string;
  orderId: string;
  requiredSignatures: number;
  createdByUserId: string;
  status: DualControlStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface DualControlSignature {
  id: string;
  approvalId: string;
  signerUserId: string;
  signedAt: Date;
  signatureNote: string | null;
}

export interface CreateApprovalRequest {
  orderId: string;
  createdByUserId: string;
  /** M in M-of-N. Defaults to 2. */
  requiredSignatures?: number;
}

export interface SignApprovalRequest {
  approvalId: string;
  signerUserId: string;
  note?: string;
}

export interface SignApprovalResult {
  approval: DualControlApproval;
  signatureCount: number;
  /** True when this signature completed the quorum and approved the order. */
  quorumReached: boolean;
}

export class DualControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class ApprovalNotFoundError extends DualControlError {}
export class ApprovalNotPendingError extends DualControlError {}
export class SelfSignatureError extends DualControlError {}
export class DuplicateSignatureError extends DualControlError {}
export class InvalidQuorumError extends DualControlError {}

interface ApprovalRow {
  id: string;
  order_id: string;
  required_signatures: number;
  created_by_user_id: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface SignatureRow {
  id: string;
  approval_id: string;
  signer_user_id: string;
  signed_at: Date;
  signature_note: string | null;
}

function toApproval(row: ApprovalRow): DualControlApproval {
  return {
    id: row.id,
    orderId: row.order_id,
    requiredSignatures: Number(row.required_signatures),
    createdByUserId: row.created_by_user_id,
    status: row.status as DualControlStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSignature(row: SignatureRow): DualControlSignature {
  return {
    id: row.id,
    approvalId: row.approval_id,
    signerUserId: row.signer_user_id,
    signedAt: row.signed_at,
    signatureNote: row.signature_note,
  };
}

const APPROVAL_COLUMNS =
  "id, order_id, required_signatures, created_by_user_id, status, created_at, updated_at";

export class DualControlService {
  constructor(private readonly db: Pool) {}

  async createApproval(request: CreateApprovalRequest): Promise<DualControlApproval> {
    const required = request.requiredSignatures ?? 2;
    if (!Number.isInteger(required) || required < 1) {
      throw new InvalidQuorumError(
        `requiredSignatures must be a positive integer, got ${String(request.requiredSignatures)}`
      );
    }

    const result = await this.db.query(
      `INSERT INTO dual_control_approvals (order_id, required_signatures, created_by_user_id)
       VALUES ($1, $2, $3)
       RETURNING ${APPROVAL_COLUMNS}`,
      [request.orderId, required, request.createdByUserId]
    );
    const approval = toApproval(result.rows[0] as ApprovalRow);
    logger.info("Dual-control approval created", {
      approvalId: approval.id,
      orderId: approval.orderId,
      requiredSignatures: approval.requiredSignatures,
    });
    return approval;
  }

  async sign(request: SignApprovalRequest): Promise<SignApprovalResult> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const result = await this.signInTransaction(client, request);
      await client.query("COMMIT");
      if (result.quorumReached) {
        logger.info("Dual-control quorum reached; order approved", {
          approvalId: result.approval.id,
          orderId: result.approval.orderId,
          signatureCount: result.signatureCount,
        });
      }
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async signInTransaction(
    client: PoolClient,
    request: SignApprovalRequest
  ): Promise<SignApprovalResult> {
    const locked = await client.query(
      `SELECT ${APPROVAL_COLUMNS} FROM dual_control_approvals WHERE id = $1 FOR UPDATE`,
      [request.approvalId]
    );
    if (locked.rows.length === 0) {
      throw new ApprovalNotFoundError(`Approval ${request.approvalId} not found`);
    }
    const approval = toApproval(locked.rows[0] as ApprovalRow);

    if (approval.status !== "pending") {
      throw new ApprovalNotPendingError(
        `Approval ${approval.id} is ${approval.status} and no longer accepts signatures`
      );
    }
    if (request.signerUserId === approval.createdByUserId) {
      throw new SelfSignatureError(
        `User ${request.signerUserId} created approval ${approval.id} and cannot sign it`
      );
    }

    const inserted = await client.query(
      `INSERT INTO dual_control_signatures (approval_id, signer_user_id, signature_note)
       VALUES ($1, $2, $3)
       ON CONFLICT (approval_id, signer_user_id) DO NOTHING
       RETURNING id`,
      [approval.id, request.signerUserId, request.note ?? null]
    );
    if (inserted.rows.length === 0) {
      throw new DuplicateSignatureError(
        `User ${request.signerUserId} has already signed approval ${approval.id}`
      );
    }

    const counted = await client.query(
      "SELECT COUNT(*)::int AS count FROM dual_control_signatures WHERE approval_id = $1",
      [approval.id]
    );
    const signatureCount = Number((counted.rows[0] as { count: number }).count);

    if (signatureCount < approval.requiredSignatures) {
      return { approval, signatureCount, quorumReached: false };
    }

    const updated = await client.query(
      `UPDATE dual_control_approvals SET status = 'approved', updated_at = NOW()
       WHERE id = $1
       RETURNING ${APPROVAL_COLUMNS}`,
      [approval.id]
    );
    await client.query(
      "UPDATE orders SET status = 'approved', updated_at = NOW() WHERE id = $1",
      [approval.orderId]
    );
    return {
      approval: toApproval(updated.rows[0] as ApprovalRow),
      signatureCount,
      quorumReached: true,
    };
  }

  async getApproval(
    approvalId: string
  ): Promise<{ approval: DualControlApproval; signatures: DualControlSignature[] } | null> {
    const approvals = await this.db.query(
      `SELECT ${APPROVAL_COLUMNS} FROM dual_control_approvals WHERE id = $1`,
      [approvalId]
    );
    if (approvals.rows.length === 0) return null;
    const signatures = await this.db.query(
      `SELECT id, approval_id, signer_user_id, signed_at, signature_note
       FROM dual_control_signatures WHERE approval_id = $1 ORDER BY signed_at, id`,
      [approvalId]
    );
    return {
      approval: toApproval(approvals.rows[0] as ApprovalRow),
      signatures: (signatures.rows as SignatureRow[]).map(toSignature),
    };
  }
}
