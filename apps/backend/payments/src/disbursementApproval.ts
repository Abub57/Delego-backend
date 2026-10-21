/**
 * Enterprise Disbursement Approval — Multi-Sig Quorum Enforcement
 * Issue #374
 *
 * Enforces 2-of-3 signatures from designated enterprise officers before
 * broadcasting high-value payouts. Verifies signatures against officer
 * public keys and tracks quorum state.
 */

import { createLogger, tracedFetch } from "@delegolabs/utils";
import * as crypto from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

const log = createLogger("payments:disbursement-approval", process.env.LOG_LEVEL ?? "info");

export type DisbursementStatus =
  | "pending"
  | "collecting"
  | "quorum_met"
  | "broadcasting"
  | "broadcast"
  | "failed"
  | "expired";

export interface OfficerSignature {
  officer: string;
  signature: string;
  signedAt: string;
  signedPayloadHash: string;
}

export interface DisbursementApprovalRequest {
  disbursementId: string;
  requiredSignatures: number;
  collectedSignatures: OfficerSignature[];
}

export interface DisbursementState {
  disbursementId: string;
  transactionXdr: string;
  officers: string[];
  requiredSignatures: number;
  collectedSignatures: OfficerSignature[];
  status: DisbursementStatus;
  createdAt: string;
  updatedAt: string;
  broadcastResult?: unknown;
  failureReason?: string;
}

export interface CreateDisbursementApprovalInput {
  disbursementId: string;
  transactionXdr: string;
  officers: string[];
  requiredSignatures?: number;
}

export interface SubmitOfficerSignatureInput {
  disbursementId: string;
  officer: string;
  signature: string;
}

export class DisbursementNotFoundError extends Error {
  constructor(disbursementId: string) {
    super(`Disbursement approval not found: ${disbursementId}`);
    this.name = "DisbursementNotFoundError";
  }
}

export class OfficerNotAuthorizedError extends Error {
  constructor(officer: string, disbursementId: string) {
    super(`Officer ${officer} is not authorized for disbursement ${disbursementId}`);
    this.name = "OfficerNotAuthorizedError";
  }
}

export class DuplicateSignatureError extends Error {
  constructor(officer: string, disbursementId: string) {
    super(`Officer ${officer} has already signed disbursement ${disbursementId}`);
    this.name = "DuplicateSignatureError";
  }
}

export class InvalidSignatureError extends Error {
  constructor(officer: string, reason: string) {
    super(`Invalid signature from officer ${officer}: ${reason}`);
    this.name = "InvalidSignatureError";
  }
}

export class DisbursementClosedError extends Error {
  constructor(disbursementId: string, status: DisbursementStatus) {
    super(`Disbursement ${disbursementId} is already ${status}`);
    this.name = "DisbursementClosedError";
  }
}

const DEFAULT_REQUIRED_SIGNATURES = 2;
const SIGNATURE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const disbursements = new Map<string, DisbursementState>();

function computePayloadHash(disbursementId: string, officer: string, signature: string): string {
  const raw = `${disbursementId}:${officer}:${signature}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function verifySignature(
  publicKey: string,
  signature: string,
  payload: string
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(publicKey);
    const payloadBuffer = Buffer.from(payload, "utf-8");
    const signatureBuffer = Buffer.from(signature, "base64");
    return keypair.verify(payloadBuffer, signatureBuffer);
  } catch {
    return false;
  }
}

function isValidStellarPublicKey(key: string): boolean {
  try {
    Keypair.fromPublicKey(key);
    return true;
  } catch {
    return false;
  }
}

export async function createDisbursementApproval(
  input: CreateDisbursementApprovalInput
): Promise<DisbursementState> {
  const { disbursementId, transactionXdr, officers, requiredSignatures } = input;

  if (!disbursementId || disbursementId.trim() === "") {
    throw new Error("disbursementId is required");
  }
  if (!transactionXdr || transactionXdr.trim() === "") {
    throw new Error("transactionXdr is required");
  }
  if (!officers || officers.length < 2) {
    throw new Error("At least 2 officers are required");
  }
  if (officers.length > 10) {
    throw new Error("Maximum 10 officers allowed");
  }

  const uniqueOfficers = [...new Set(officers.map((o) => o.trim()).filter(Boolean))];
  if (uniqueOfficers.length !== officers.length) {
    throw new Error("Duplicate officer public keys are not allowed");
  }

  for (const officer of uniqueOfficers) {
    if (!isValidStellarPublicKey(officer)) {
      throw new Error(`Invalid Stellar public key for officer: ${officer}`);
    }
  }

  const resolvedRequired = requiredSignatures ?? Math.min(DEFAULT_REQUIRED_SIGNATURES, uniqueOfficers.length);
  if (resolvedRequired < 1 || resolvedRequired > uniqueOfficers.length) {
    throw new Error(
      `requiredSignatures must be between 1 and ${uniqueOfficers.length} (number of officers)`
    );
  }

  const now = new Date().toISOString();
  const state: DisbursementState = {
    disbursementId,
    transactionXdr,
    officers: uniqueOfficers,
    requiredSignatures: resolvedRequired,
    collectedSignatures: [],
    status: "collecting",
    createdAt: now,
    updatedAt: now,
  };

  disbursements.set(disbursementId, state);

  log.info("Disbursement approval created", {
    disbursementId,
    officers: uniqueOfficers.length,
    requiredSignatures: resolvedRequired,
  });

  return state;
}

export async function collectOfficerSignature(
  input: SubmitOfficerSignatureInput
): Promise<DisbursementState> {
  const { disbursementId, officer, signature } = input;

  if (!disbursementId || !officer || !signature) {
    throw new Error("disbursementId, officer, and signature are required");
  }

  const state = disbursements.get(disbursementId);
  if (!state) {
    throw new DisbursementNotFoundError(disbursementId);
  }

  if (state.status !== "collecting" && state.status !== "pending") {
    throw new DisbursementClosedError(disbursementId, state.status);
  }

  if (!state.officers.includes(officer)) {
    throw new OfficerNotAuthorizedError(officer, disbursementId);
  }

  if (state.collectedSignatures.some((s) => s.officer === officer)) {
    throw new DuplicateSignatureError(officer, disbursementId);
  }

  const payload = `${disbursementId}:${state.transactionXdr}`;
  if (!verifySignature(officer, signature, payload)) {
    throw new InvalidSignatureError(officer, "Signature verification failed");
  }

  const signedPayloadHash = computePayloadHash(disbursementId, officer, signature);

  const officerSig: OfficerSignature = {
    officer,
    signature,
    signedAt: new Date().toISOString(),
    signedPayloadHash,
  };

  state.collectedSignatures.push(officerSig);
  state.updatedAt = new Date().toISOString();

  log.info("Officer signature collected", {
    disbursementId,
    officer,
    collected: state.collectedSignatures.length,
    required: state.requiredSignatures,
  });

  if (state.collectedSignatures.length >= state.requiredSignatures) {
    state.status = "quorum_met";
    await broadcastDisbursement(state);
  }

  return state;
}

async function broadcastDisbursement(state: DisbursementState): Promise<void> {
  state.status = "broadcasting";
  state.updatedAt = new Date().toISOString();

  log.info("Broadcasting disbursement transaction", {
    disbursementId: state.disbursementId,
    signers: state.collectedSignatures.map((s) => s.officer),
  });

  try {
    const walletUrl = process.env.WALLET_SERVICE_URL ?? "http://localhost:3012";
    const res = await tracedFetch(`${walletUrl}/tx/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        xdr: state.transactionXdr,
        signatures: state.collectedSignatures.map((s) => ({
          publicKey: s.officer,
          signature: s.signature,
        })),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Wallet service error: ${res.status} ${body}`);
    }

    const result = await res.json();
    state.broadcastResult = result;
    state.status = "broadcast";
    state.updatedAt = new Date().toISOString();

    log.info("Disbursement broadcast successful", {
      disbursementId: state.disbursementId,
      result,
    });
  } catch (err) {
    state.status = "failed";
    state.failureReason = err instanceof Error ? err.message : "Unknown broadcast error";
    state.updatedAt = new Date().toISOString();

    log.error("Disbursement broadcast failed", {
      disbursementId: state.disbursementId,
      error: state.failureReason,
    });
    throw err;
  }
}

export function getDisbursementState(disbursementId: string): DisbursementState | null {
  return disbursements.get(disbursementId) ?? null;
}

export async function submitDisbursementApproval(
  disbursementId: string
): Promise<DisbursementState> {
  const state = disbursements.get(disbursementId);
  if (!state) {
    throw new DisbursementNotFoundError(disbursementId);
  }

  if (state.status === "broadcast") {
    return state;
  }

  if (state.collectedSignatures.length < state.requiredSignatures) {
    throw new Error(
      `Quorum not met: ${state.collectedSignatures.length}/${state.requiredSignatures} signatures`
    );
  }

  await broadcastDisbursement(state);
  return state;
}

export function listDisbursements(): DisbursementState[] {
  return Array.from(disbursements.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function expireStaleDisbursements(): Promise<number> {
  const now = Date.now();
  let expired = 0;

  for (const [id, state] of disbursements.entries()) {
    if (state.status === "collecting" || state.status === "pending") {
      const createdAt = new Date(state.createdAt).getTime();
      if (now - createdAt > SIGNATURE_TTL_MS) {
        state.status = "expired";
        state.updatedAt = new Date().toISOString();
        expired++;
        log.info("Disbursement expired", { disbursementId: id });
      }
    }
  }

  if (expired > 0) {
    log.info(`Expired ${expired} stale disbursement approvals`);
  }

  return expired;
}

export function resetDisbursementStore(): void {
  disbursements.clear();
}