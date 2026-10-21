import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  DualControlService,
  DuplicateSignatureError,
  InvalidQuorumError,
  SelfSignatureError,
} from "./service.js";

// ---------------------------------------------------------------------------
// A small in-memory stand-in for the two tables plus `orders.status`, which
// understands exactly the statements DualControlService issues and rolls back
// on ROLLBACK. The same logic runs against real Postgres in service.pg.test.ts.
// ---------------------------------------------------------------------------

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
interface State {
  approvals: ApprovalRow[];
  signatures: SignatureRow[];
  orders: Record<string, string>;
}

class FakeDb {
  state: State = { approvals: [], signatures: [], orders: {} };
  private snapshot: State | null = null;
  private seq = 0;

  private clone(s: State): State {
    return {
      approvals: s.approvals.map((a) => ({ ...a })),
      signatures: s.signatures.map((x) => ({ ...x })),
      orders: { ...s.orders },
    };
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    const s = this.state;
    if (sql === "BEGIN") {
      this.snapshot = this.clone(s);
      return { rows: [] };
    }
    if (sql === "COMMIT") {
      this.snapshot = null;
      return { rows: [] };
    }
    if (sql === "ROLLBACK") {
      if (this.snapshot) this.state = this.snapshot;
      this.snapshot = null;
      return { rows: [] };
    }
    if (/^INSERT INTO dual_control_approvals/.test(sql)) {
      const now = new Date();
      const row: ApprovalRow = {
        id: `appr-${++this.seq}`,
        order_id: params[0] as string,
        required_signatures: params[1] as number,
        created_by_user_id: params[2] as string,
        status: "pending",
        created_at: now,
        updated_at: now,
      };
      s.approvals.push(row);
      return { rows: [{ ...row }] };
    }
    if (/FROM dual_control_approvals WHERE id = \$1/.test(sql)) {
      return { rows: s.approvals.filter((a) => a.id === params[0]).map((a) => ({ ...a })) };
    }
    if (/^INSERT INTO dual_control_signatures/.test(sql)) {
      const [approvalId, signer, note] = params as [string, string, string | null];
      if (s.signatures.some((x) => x.approval_id === approvalId && x.signer_user_id === signer)) {
        return { rows: [] }; // ON CONFLICT DO NOTHING
      }
      const row = {
        id: `sig-${++this.seq}`,
        approval_id: approvalId,
        signer_user_id: signer,
        signed_at: new Date(),
        signature_note: note,
      };
      s.signatures.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (/SELECT COUNT\(\*\)::int AS count FROM dual_control_signatures/.test(sql)) {
      return { rows: [{ count: s.signatures.filter((x) => x.approval_id === params[0]).length }] };
    }
    if (/^UPDATE dual_control_approvals SET status = 'approved'/.test(sql)) {
      const row = s.approvals.find((a) => a.id === params[0])!;
      row.status = "approved";
      row.updated_at = new Date();
      return { rows: [{ ...row }] };
    }
    if (/^UPDATE orders SET status = 'approved'/.test(sql)) {
      s.orders[params[0] as string] = "approved";
      return { rows: [] };
    }
    if (/FROM dual_control_signatures WHERE approval_id = \$1 ORDER BY/.test(sql)) {
      return { rows: s.signatures.filter((x) => x.approval_id === params[0]) };
    }
    throw new Error(`FakeDb: unexpected SQL: ${sql}`);
  }

  async connect() {
    return { query: this.query.bind(this), release: () => {} };
  }
}

function makeService() {
  const db = new FakeDb();
  db.state.orders["order-1"] = "pending_approval";
  return { db, service: new DualControlService(db as unknown as Pool) };
}

describe("DualControlService", () => {
  it("creates a pending approval needing 2 signatures by default", async () => {
    const { service } = makeService();
    const approval = await service.createApproval({ orderId: "order-1", createdByUserId: "alice" });
    expect(approval).toMatchObject({
      orderId: "order-1",
      createdByUserId: "alice",
      requiredSignatures: 2,
      status: "pending",
    });
  });

  it.each([0, -1, 1.5])("rejects requiredSignatures = %s", async (required) => {
    const { service } = makeService();
    await expect(
      service.createApproval({ orderId: "order-1", createdByUserId: "alice", requiredSignatures: required })
    ).rejects.toBeInstanceOf(InvalidQuorumError);
  });

  it("does not let the creator sign their own proposal", async () => {
    const { service, db } = makeService();
    const approval = await service.createApproval({ orderId: "order-1", createdByUserId: "alice" });

    await expect(service.sign({ approvalId: approval.id, signerUserId: "alice" })).rejects.toBeInstanceOf(
      SelfSignatureError
    );
    expect(db.state.signatures).toHaveLength(0);
  });

  it("approves the order only once the quorum is met", async () => {
    const { service, db } = makeService();
    const approval = await service.createApproval({
      orderId: "order-1",
      createdByUserId: "alice",
      requiredSignatures: 3,
    });

    const first = await service.sign({ approvalId: approval.id, signerUserId: "bob" });
    expect(first).toMatchObject({ signatureCount: 1, quorumReached: false });
    expect(first.approval.status).toBe("pending");
    expect(db.state.orders["order-1"]).toBe("pending_approval");

    const second = await service.sign({ approvalId: approval.id, signerUserId: "carol" });
    expect(second).toMatchObject({ signatureCount: 2, quorumReached: false });
    expect(db.state.orders["order-1"]).toBe("pending_approval");

    const third = await service.sign({ approvalId: approval.id, signerUserId: "dave", note: "ok" });
    expect(third).toMatchObject({ signatureCount: 3, quorumReached: true });
    expect(third.approval.status).toBe("approved");
    expect(db.state.orders["order-1"]).toBe("approved");
  });

  it("does not count the same signer twice", async () => {
    const { service, db } = makeService();
    const approval = await service.createApproval({ orderId: "order-1", createdByUserId: "alice" });
    await service.sign({ approvalId: approval.id, signerUserId: "bob" });

    await expect(service.sign({ approvalId: approval.id, signerUserId: "bob" })).rejects.toBeInstanceOf(
      DuplicateSignatureError
    );
    expect(db.state.signatures).toHaveLength(1);
    expect(db.state.orders["order-1"]).toBe("pending_approval");
  });

  it("refuses signatures after approval", async () => {
    const { service, db } = makeService();
    const approval = await service.createApproval({
      orderId: "order-1",
      createdByUserId: "alice",
      requiredSignatures: 1,
    });
    await service.sign({ approvalId: approval.id, signerUserId: "bob" });

    await expect(service.sign({ approvalId: approval.id, signerUserId: "carol" })).rejects.toBeInstanceOf(
      ApprovalNotPendingError
    );
    expect(db.state.signatures).toHaveLength(1);
  });

  it("reports an unknown approval", async () => {
    const { service } = makeService();
    await expect(service.sign({ approvalId: "nope", signerUserId: "bob" })).rejects.toBeInstanceOf(
      ApprovalNotFoundError
    );
  });

  it("rolls back when anything fails mid-signature", async () => {
    const { service, db } = makeService();
    const approval = await service.createApproval({
      orderId: "order-1",
      createdByUserId: "alice",
      requiredSignatures: 1,
    });
    const original = db.query.bind(db);
    db.query = async (sql: string, params?: unknown[]) => {
      if (/^UPDATE orders/.test(sql)) throw new Error("connection lost");
      return original(sql, params);
    };

    await expect(service.sign({ approvalId: approval.id, signerUserId: "bob" })).rejects.toThrow(
      "connection lost"
    );
    expect(db.state.signatures).toHaveLength(0);
    expect(db.state.approvals[0].status).toBe("pending");
  });

  it("returns an approval with its signatures", async () => {
    const { service } = makeService();
    const approval = await service.createApproval({ orderId: "order-1", createdByUserId: "alice" });
    await service.sign({ approvalId: approval.id, signerUserId: "bob", note: "looks right" });

    const found = await service.getApproval(approval.id);
    expect(found?.approval.id).toBe(approval.id);
    expect(found?.signatures).toEqual([
      expect.objectContaining({ signerUserId: "bob", signatureNote: "looks right" }),
    ]);
    expect(await service.getApproval("nope")).toBeNull();
  });
});
