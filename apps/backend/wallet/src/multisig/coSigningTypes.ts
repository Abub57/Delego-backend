/**
 * Multi-Sig Dual-Control Co-Signing Coordination — shared types
 * Issue #289
 *
 * Coordinates collecting signatures from multiple authorized team members
 * before submitting a Stellar transaction once the threshold is satisfied.
 */

export interface CollectedSignature {
  signerAddress: string;
  signatureBase64: string;
}

export type CoSigningSessionStatus =
  | "collecting"
  | "ready"
  | "submitted"
  | "expired";

export interface MultiSigSession {
  sessionId: string;
  orderId: string;
  transactionXdr: string;
  requiredThreshold: number;
  collectedSignatures: CollectedSignature[];
  status: CoSigningSessionStatus;
}

export interface CreateCoSigningSessionInput {
  orderId: string;
  transactionXdr: string;
  requiredThreshold: number;
  /** Stellar G... addresses authorized to co-sign. Omit to allow any valid signer. */
  authorizedSigners?: string[];
  /** Session TTL in ms; defaults to 15 minutes. */
  ttlMs?: number;
}

export interface AddCoSignatureInput {
  sessionId: string;
  signerAddress: string;
  signatureBase64: string;
}

/** Submits a fully-signed envelope XDR to the Stellar network. Injected by callers. */
export type SubmitCombinedTransaction = (
  combinedXdr: string,
) => Promise<unknown>;
