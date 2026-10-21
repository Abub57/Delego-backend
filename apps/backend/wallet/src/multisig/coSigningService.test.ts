/**
 * Unit tests for Multi-Sig Dual-Control Co-Signing Coordination Service
 * Issue #289
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  addCoSignature,
  combineSignaturesIntoEnvelope,
  createCoSigningSession,
  expireCoSigningSession,
  getCoSigningSession,
  resetCoSigningSessionStore,
  submitCoSigningSession,
  validatePartialSignature,
} from "./coSigningService.js";

const NETWORK = Networks.TESTNET;

function buildEnvelopeXdr(sourceKp: Keypair): string {
  const account = new Account(sourceKp.publicKey(), "0");
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.manageData({
        name: "order",
        value: Buffer.from("dual-control"),
      }),
    )
    .setTimeout(30)
    .build();
  return tx.toEnvelope().toXDR("base64");
}

function detachedSignatureBase64(
  transactionXdr: string,
  signer: Keypair,
): string {
  const tx = TransactionBuilder.fromXDR(transactionXdr, NETWORK);
  if (!(tx instanceof Transaction)) throw new Error("expected Transaction");
  const sig = signer.sign(tx.hash());
  return Buffer.from(sig).toString("base64");
}

function combinedSignatureCount(combinedXdr: string): number {
  const tx = TransactionBuilder.fromXDR(combinedXdr, NETWORK);
  if (!(tx instanceof Transaction)) throw new Error("expected Transaction");
  return tx.signatures.length;
}

beforeEach(() => {
  process.env.STELLAR_NETWORK = "testnet";
  resetCoSigningSessionStore();
  vi.clearAllMocks();
});

describe("createCoSigningSession", () => {
  it("creates a collecting session with order linkage", async () => {
    const kp = Keypair.random();
    const session = await createCoSigningSession({
      orderId: "order-123",
      transactionXdr: buildEnvelopeXdr(kp),
      requiredThreshold: 2,
      authorizedSigners: [Keypair.random().publicKey(), Keypair.random().publicKey()],
    });
    expect(session.sessionId).toBeDefined();
    expect(session.orderId).toBe("order-123");
    expect(session.requiredThreshold).toBe(2);
    expect(session.collectedSignatures).toHaveLength(0);
    expect(session.status).toBe("collecting");
  });

  it("rejects invalid XDR", async () => {
    await expect(
      createCoSigningSession({
        orderId: "o1",
        transactionXdr: "not-xdr",
        requiredThreshold: 1,
      }),
    ).rejects.toThrow(/Invalid transaction XDR/);
  });

  it("rejects threshold exceeding authorized signers", async () => {
    const kp = Keypair.random();
    await expect(
      createCoSigningSession({
        orderId: "o1",
        transactionXdr: buildEnvelopeXdr(kp),
        requiredThreshold: 3,
        authorizedSigners: [kp.publicKey()],
      }),
    ).rejects.toThrow(/exceeds authorized signer count/);
  });
});

describe("validatePartialSignature", () => {
  it("accepts a valid detached signature", async () => {
    const source = Keypair.random();
    const signer = Keypair.random();
    const xdr = buildEnvelopeXdr(source);
    const sig = detachedSignatureBase64(xdr, signer);
    expect(() =>
      validatePartialSignature(xdr, signer.publicKey(), sig),
    ).not.toThrow();
  });

  it("rejects a signature from a different key", async () => {
    const source = Keypair.random();
    const signer = Keypair.random();
    const other = Keypair.random();
    const xdr = buildEnvelopeXdr(source);
    const sig = detachedSignatureBase64(xdr, signer);
    expect(() =>
      validatePartialSignature(xdr, other.publicKey(), sig),
    ).toThrow(/verification failed/);
  });
});

describe("addCoSignature", () => {
  it("collects below threshold and auto-submits at threshold with combined envelope", async () => {
    const source = Keypair.random();
    const a = Keypair.random();
    const b = Keypair.random();
    const xdr = buildEnvelopeXdr(source);
    const session = await createCoSigningSession({
      orderId: "order-1",
      transactionXdr: xdr,
      requiredThreshold: 2,
      authorizedSigners: [a.publicKey(), b.publicKey()],
    });

    const submit = vi.fn().mockResolvedValue({ hash: "abc" });
    const afterFirst = await addCoSignature(
      {
        sessionId: session.sessionId,
        signerAddress: a.publicKey(),
        signatureBase64: detachedSignatureBase64(xdr, a),
      },
      submit,
    );
    expect(afterFirst.status).toBe("collecting");
    expect(afterFirst.collectedSignatures).toHaveLength(1);
    expect(submit).not.toHaveBeenCalled();

    const final = await addCoSignature(
      {
        sessionId: session.sessionId,
        signerAddress: b.publicKey(),
        signatureBase64: detachedSignatureBase64(xdr, b),
      },
      submit,
    );
    expect(final.status).toBe("submitted");
    expect(final.collectedSignatures).toHaveLength(2);
    expect(submit).toHaveBeenCalledTimes(1);

    const combined = submit.mock.calls[0][0] as string;
    expect(combinedSignatureCount(combined)).toBe(2);
  });

  it("rejects unauthorized signer", async () => {
    const source = Keypair.random();
    const a = Keypair.random();
    const outsider = Keypair.random();
    const xdr = buildEnvelopeXdr(source);
    const session = await createCoSigningSession({
      orderId: "o",
      transactionXdr: xdr,
      requiredThreshold: 1,
      authorizedSigners: [a.publicKey()],
    });
    await expect(
      addCoSignature({
        sessionId: session.sessionId,
        signerAddress: outsider.publicKey(),
        signatureBase64: detachedSignatureBase64(xdr, outsider),
      }),
    ).rejects.toThrow(/not authorized/);
  });

  it("rejects duplicate signatures", async () => {
    const source = Keypair.random();
    const a = Keypair.random();
    const b = Keypair.random();
    const xdr = buildEnvelopeXdr(source);
    const session = await createCoSigningSession({
      orderId: "o",
      transactionXdr: xdr,
      requiredThreshold: 2,
      authorizedSigners: [a.publicKey(), b.publicKey()],
    });
    await addCoSignature({
      sessionId: session.sessionId,
      signerAddress: a.publicKey(),
      signatureBase64: detachedSignatureBase64(xdr, a),
    });
    await expect(
      addCoSignature({
        sessionId: session.sessionId,
        signerAddress: a.publicKey(),
        signatureBase64: detachedSignatureBase64(xdr, a),
      }),
    ).rejects.toThrow(/already submitted/);
  });

  it("rejects tampered signatures", async () => {
    const source = Keypair.random();
    const a = Keypair.random();
    const xdr = buildEnvelopeXdr(source);
    const otherXdr = buildEnvelopeXdr(Keypair.random());
    const session = await createCoSigningSession({
      orderId: "o",
      transactionXdr: xdr,
      requiredThreshold: 1,
      authorizedSigners: [a.publicKey()],
    });
    // Signature over a different transaction must fail validation.
    const badSig = detachedSignatureBase64(otherXdr, a);
    await expect(
      addCoSignature({
        sessionId: session.sessionId,
        signerAddress: a.publicKey(),
        signatureBase64: badSig,
      }),
    ).rejects.toThrow(/verification failed/);
  });
});

describe("combine + submit + expiry", () => {
  it("combines signatures into a unified envelope via SDK", async () => {
    const source = Keypair.random();
    const a = Keypair.random();
    const b = Keypair.random();
    const xdr = buildEnvelopeXdr(source);
    const combined = combineSignaturesIntoEnvelope(xdr, [
      { signerAddress: a.publicKey(), signatureBase64: detachedSignatureBase64(xdr, a) },
      { signerAddress: b.publicKey(), signatureBase64: detachedSignatureBase64(xdr, b) },
    ]);
    expect(combinedSignatureCount(combined)).toBe(2);
  });

  it("explicit submit throws when threshold not met", async () => {
    const source = Keypair.random();
    const a = Keypair.random();
    const b = Keypair.random();
    const xdr = buildEnvelopeXdr(source);
    const session = await createCoSigningSession({
      orderId: "o",
      transactionXdr: xdr,
      requiredThreshold: 2,
      authorizedSigners: [a.publicKey(), b.publicKey()],
    });
    await addCoSignature({
      sessionId: session.sessionId,
      signerAddress: a.publicKey(),
      signatureBase64: detachedSignatureBase64(xdr, a),
    });
    await expect(submitCoSigningSession(session.sessionId)).rejects.toThrow(
      /Threshold not met/,
    );
    const fetched = await getCoSigningSession(session.sessionId);
    expect(fetched?.status).toBe("collecting");
  });

  it("expires sessions past TTL", async () => {
    const source = Keypair.random();
    const a = Keypair.random();
    const xdr = buildEnvelopeXdr(source);
    const session = await createCoSigningSession({
      orderId: "o",
      transactionXdr: xdr,
      requiredThreshold: 1,
      authorizedSigners: [a.publicKey()],
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 5));
    const expired = await expireCoSigningSession(session.sessionId, Date.now());
    expect(expired.status).toBe("expired");
  });
});
