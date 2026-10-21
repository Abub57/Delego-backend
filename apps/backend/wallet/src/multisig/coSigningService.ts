/**
 * Multi-Sig Dual-Control Co-Signing Coordination Service
 * Issue #289
 *
 * Collects detached Ed25519 signatures from authorized team members against
 * a Stellar transaction hash, combines them into a unified transaction
 * envelope via the Stellar SDK once the threshold is satisfied, and submits
 * the envelope to the network.
 *
 * Each partial signature is cryptographically validated against the claimed
 * signer public key before it is accepted.
 */
import * as crypto from "node:crypto";
import {
  Keypair,
  Networks,
  Horizon,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { createLogger } from "@delegolabs/utils";
import type {
  AddCoSignatureInput,
  CoSigningSessionStatus,
  CreateCoSigningSessionInput,
  MultiSigSession,
  SubmitCombinedTransaction,
} from "./coSigningTypes.js";

const log = createLogger(
  "wallet:multisig:cosigning",
  process.env.LOG_LEVEL ?? "info",
);

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class CoSigningSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Co-signing session not found: ${sessionId}`);
    this.name = "CoSigningSessionNotFoundError";
  }
}

export class CoSigningSessionClosedError extends Error {
  constructor(sessionId: string, status: CoSigningSessionStatus) {
    super(`Co-signing session ${sessionId} is already ${status}`);
    this.name = "CoSigningSessionClosedError";
  }
}

export class UnauthorizedCoSignerError extends Error {
  constructor(signer: string) {
    super(`Signer ${signer} is not authorized for this session`);
    this.name = "UnauthorizedCoSignerError";
  }
}

export class InvalidCoSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCoSignatureError";
  }
}

// ---------------------------------------------------------------------------
// Store — in-memory by default, swappable for a DB-backed store.
// ---------------------------------------------------------------------------

interface StoredCoSigningSession extends MultiSigSession {
  authorizedSigners: string[];
  createdAt: number;
  expiresAt: number;
  combinedXdr?: string;
  submissionResult?: unknown;
  failureReason?: string;
}

export interface CoSigningSessionStore {
  create(session: StoredCoSigningSession): Promise<void>;
  get(sessionId: string): Promise<StoredCoSigningSession | null>;
  save(session: StoredCoSigningSession): Promise<void>;
}

export class InMemoryCoSigningSessionStore
  implements CoSigningSessionStore
{
  private readonly sessions = new Map<string, StoredCoSigningSession>();

  async create(session: StoredCoSigningSession): Promise<void> {
    this.sessions.set(session.sessionId, session);
  }

  async get(sessionId: string): Promise<StoredCoSigningSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async save(session: StoredCoSigningSession): Promise<void> {
    this.sessions.set(session.sessionId, session);
  }

  clear(): void {
    this.sessions.clear();
  }
}

let store: CoSigningSessionStore = new InMemoryCoSigningSessionStore();

export function setCoSigningSessionStore(
  newStore: CoSigningSessionStore,
): void {
  store = newStore;
}

export function resetCoSigningSessionStore(): void {
  store = new InMemoryCoSigningSessionStore();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveNetworkPassphrase(): string {
  const network = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  if (network === "mainnet") return Networks.PUBLIC;
  if (network === "futurenet") return Networks.FUTURENET;
  return Networks.TESTNET;
}

function parseBaseTransaction(transactionXdr: string): Transaction {
  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXDR(
      transactionXdr,
      resolveNetworkPassphrase(),
    );
  } catch (err) {
    throw new InvalidCoSignatureError(
      `Invalid transaction XDR: ${(err as Error).message}`,
    );
  }
  if (!(parsed instanceof Transaction)) {
    throw new InvalidCoSignatureError(
      "Only classic transactions are supported; fee-bump envelopes are not supported",
    );
  }
  return parsed;
}

function toPublicSession(stored: StoredCoSigningSession): MultiSigSession {
  return {
    sessionId: stored.sessionId,
    orderId: stored.orderId,
    transactionXdr: stored.transactionXdr,
    requiredThreshold: stored.requiredThreshold,
    collectedSignatures: [...stored.collectedSignatures],
    status: stored.status,
  };
}

function decodeSignature(signatureBase64: string): Buffer {
  if (!signatureBase64 || signatureBase64.trim() === "") {
    throw new InvalidCoSignatureError("signatureBase64 is required");
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(signatureBase64, "base64");
  } catch {
    throw new InvalidCoSignatureError("signatureBase64 is not valid base64");
  }
  if (raw.length !== 64) {
    throw new InvalidCoSignatureError(
      `signatureBase64 must decode to 64 bytes (Ed25519), got ${raw.length}`,
    );
  }
  return raw;
}

/**
 * Validates a detached signature against the transaction hash and the
 * claimed signer public key. Throws InvalidCoSignatureError on failure.
 */
export function validatePartialSignature(
  transactionXdr: string,
  signerAddress: string,
  signatureBase64: string,
): void {
  let keypair: Keypair;
  try {
    keypair = Keypair.fromPublicKey(signerAddress);
  } catch {
    throw new InvalidCoSignatureError(
      `Invalid signer Stellar public key: ${signerAddress}`,
    );
  }
  const signature = decodeSignature(signatureBase64);
  const tx = parseBaseTransaction(transactionXdr);
  const hash = tx.hash();
  if (!keypair.verify(hash, signature)) {
    throw new InvalidCoSignatureError(
      `Signature verification failed for signer ${signerAddress}`,
    );
  }
}

/**
 * Combines all collected detached signatures into a unified Stellar
 * transaction envelope via the SDK.
 */
export function combineSignaturesIntoEnvelope(
  transactionXdr: string,
  collectedSignatures: { signerAddress: string; signatureBase64: string }[],
): string {
  const tx = parseBaseTransaction(transactionXdr);
  const seen = new Set<string>();
  for (const { signerAddress, signatureBase64 } of collectedSignatures) {
    const signature = decodeSignature(signatureBase64);
    const hint = Keypair.fromPublicKey(signerAddress).signatureHint();
    const key = `${hint.toString("hex")}:${signature.toString("hex")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tx.signatures.push(new xdr.DecoratedSignature({ hint, signature }));
  }
  return tx.toEnvelope().toXDR("base64");
}

/** Default Horizon submitter used when callers want on-chain submission. */
export function createHorizonSubmitter(): SubmitCombinedTransaction {
  const network = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  const horizonUrl =
    process.env.STELLAR_HORIZON_URL ??
    (network === "mainnet"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org");
  const server = new Horizon.Server(horizonUrl);
  return async (combinedXdr: string) => {
    const tx = TransactionBuilder.fromXDR(
      combinedXdr,
      resolveNetworkPassphrase(),
    );
    if (!(tx instanceof Transaction)) {
      throw new Error("Combined envelope is not a classic transaction");
    }
    return server.submitTransaction(tx);
  };
}

function isExpired(stored: StoredCoSigningSession, now: number): boolean {
  return stored.expiresAt <= now;
}

async function markExpired(
  stored: StoredCoSigningSession,
): Promise<StoredCoSigningSession> {
  if (stored.status === "collecting" || stored.status === "ready") {
    stored.status = "expired";
    await store.save(stored);
    log.info("Co-signing session expired", { sessionId: stored.sessionId });
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function createCoSigningSession(
  input: CreateCoSigningSessionInput,
): Promise<MultiSigSession> {
  const {
    orderId,
    transactionXdr,
    requiredThreshold,
    authorizedSigners,
    ttlMs = DEFAULT_SESSION_TTL_MS,
  } = input;

  if (!orderId || orderId.trim() === "") {
    throw new Error("orderId is required");
  }
  if (!transactionXdr || transactionXdr.trim() === "") {
    throw new Error("transactionXdr is required");
  }
  // Validates the envelope parses under the configured network passphrase.
  parseBaseTransaction(transactionXdr);

  const uniqueSigners = [...new Set((authorizedSigners ?? []).map((s) => s.trim()).filter(Boolean))];
  for (const address of uniqueSigners) {
    try {
      Keypair.fromPublicKey(address);
    } catch {
      throw new Error(`Invalid authorized signer Stellar public key: ${address}`);
    }
  }

  if (!Number.isInteger(requiredThreshold) || requiredThreshold < 1) {
    throw new Error("requiredThreshold must be a positive integer");
  }
  if (uniqueSigners.length > 0 && requiredThreshold > uniqueSigners.length) {
    throw new Error(
      `requiredThreshold (${requiredThreshold}) exceeds authorized signer count (${uniqueSigners.length})`,
    );
  }

  const now = Date.now();
  const stored: StoredCoSigningSession = {
    sessionId: crypto.randomUUID(),
    orderId,
    transactionXdr,
    requiredThreshold,
    collectedSignatures: [],
    status: "collecting",
    authorizedSigners: uniqueSigners,
    createdAt: now,
    expiresAt: now + ttlMs,
  };

  await store.create(stored);
  log.info("Co-signing session created", {
    sessionId: stored.sessionId,
    orderId,
    requiredThreshold,
  });
  return toPublicSession(stored);
}

export async function getCoSigningSession(
  sessionId: string,
): Promise<MultiSigSession | null> {
  const stored = await store.get(sessionId);
  if (!stored) return null;
  if (
    (stored.status === "collecting" || stored.status === "ready") &&
    isExpired(stored, Date.now())
  ) {
    await markExpired(stored);
  }
  return toPublicSession(stored);
}

async function submitStoredSession(
  stored: StoredCoSigningSession,
  submit?: SubmitCombinedTransaction,
): Promise<void> {
  const combined = combineSignaturesIntoEnvelope(
    stored.transactionXdr,
    stored.collectedSignatures,
  );
  stored.combinedXdr = combined;
  try {
    if (submit) {
      stored.submissionResult = await submit(combined);
    }
    stored.status = "submitted";
    await store.save(stored);
    log.info("Co-signing session submitted", { sessionId: stored.sessionId });
  } catch (err) {
    stored.failureReason = err instanceof Error ? err.message : "Unknown submission error";
    await store.save(stored);
    log.error("Co-signing session submission failed", {
      sessionId: stored.sessionId,
      error: stored.failureReason,
    });
    throw err;
  }
}

/**
 * Collects one team-member signature after cryptographic validation.
 * Auto-combines and submits once the threshold is satisfied.
 */
export async function addCoSignature(
  input: AddCoSignatureInput,
  submit?: SubmitCombinedTransaction,
  now = Date.now(),
): Promise<MultiSigSession> {
  const { sessionId, signerAddress, signatureBase64 } = input;
  const stored = await store.get(sessionId);
  if (!stored) throw new CoSigningSessionNotFoundError(sessionId);

  if (isExpired(stored, now)) {
    await markExpired(stored);
    throw new CoSigningSessionClosedError(sessionId, "expired");
  }
  if (stored.status !== "collecting") {
    throw new CoSigningSessionClosedError(sessionId, stored.status);
  }
  if (
    stored.authorizedSigners.length > 0 &&
    !stored.authorizedSigners.includes(signerAddress)
  ) {
    throw new UnauthorizedCoSignerError(signerAddress);
  }
  if (
    stored.collectedSignatures.some((s) => s.signerAddress === signerAddress)
  ) {
    throw new Error(
      `Signer ${signerAddress} has already submitted a signature for session ${sessionId}`,
    );
  }

  // Acceptance criteria: validate each partial signature against the signer key.
  validatePartialSignature(stored.transactionXdr, signerAddress, signatureBase64);

  stored.collectedSignatures.push({ signerAddress, signatureBase64 });
  log.info("Partial co-signature collected", {
    sessionId,
    signerAddress,
    collected: stored.collectedSignatures.length,
    requiredThreshold: stored.requiredThreshold,
  });

  if (stored.collectedSignatures.length >= stored.requiredThreshold) {
    stored.status = "ready";
    await store.save(stored);
    await submitStoredSession(stored, submit);
    const refreshed = await store.get(sessionId);
    if (!refreshed) throw new CoSigningSessionNotFoundError(sessionId);
    return toPublicSession(refreshed);
  }

  await store.save(stored);
  return toPublicSession(stored);
}

/**
 * Explicitly combines + submits a session that already reached `ready`.
 * Useful when callers pass no submitter to addCoSignature and want to
 * control network submission timing.
 */
export async function submitCoSigningSession(
  sessionId: string,
  submit?: SubmitCombinedTransaction,
  now = Date.now(),
): Promise<MultiSigSession> {
  const stored = await store.get(sessionId);
  if (!stored) throw new CoSigningSessionNotFoundError(sessionId);

  if (isExpired(stored, now)) {
    await markExpired(stored);
    throw new CoSigningSessionClosedError(sessionId, "expired");
  }
  if (stored.status === "submitted") return toPublicSession(stored);
  if (stored.status === "expired") {
    throw new CoSigningSessionClosedError(sessionId, stored.status);
  }
  if (stored.collectedSignatures.length < stored.requiredThreshold) {
    throw new Error(
      `Threshold not met: ${stored.collectedSignatures.length}/${stored.requiredThreshold} signatures`,
    );
  }
  stored.status = "ready";
  await submitStoredSession(stored, submit);
  const refreshed = await store.get(sessionId);
  if (!refreshed) throw new CoSigningSessionNotFoundError(sessionId);
  return toPublicSession(refreshed);
}

export async function expireCoSigningSession(
  sessionId: string,
  now = Date.now(),
): Promise<MultiSigSession> {
  const stored = await store.get(sessionId);
  if (!stored) throw new CoSigningSessionNotFoundError(sessionId);
  if (stored.status === "collecting" || stored.status === "ready") {
    if (isExpired(stored, now)) {
      await markExpired(stored);
    } else {
      stored.status = "expired";
      await store.save(stored);
    }
  }
  const refreshed = await store.get(sessionId);
  if (!refreshed) throw new CoSigningSessionNotFoundError(sessionId);
  return toPublicSession(refreshed);
}

/** Sweeps stale sessions; returns number expired. */
export async function expireStaleCoSigningSessions(
  now = Date.now(),
): Promise<number> {
  // In-memory store has no enumeration API; callers expire by id.
  // Kept for API symmetry with expireStaleProposals(); DB-backed stores
  // can override with a bulk query.
  void now;
  return 0;
}
