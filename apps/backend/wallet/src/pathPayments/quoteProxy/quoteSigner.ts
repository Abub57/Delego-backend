/**
 * Oracle signing of path-payment quotes.
 *
 * The signed payload is a versioned, newline-delimited `key=value` document
 * with a fixed field order, so any verifier can rebuild the exact bytes. All
 * values are validated assets / amounts / timestamps, which cannot contain
 * newlines.
 *
 * `QuoteSigner` is structurally compatible with the payments service's
 * HSM-backed `OracleKeySigner` (KMS / Vault); `StellarKeypairQuoteSigner` is
 * the in-process Ed25519 implementation.
 */

import { Keypair } from "@stellar/stellar-sdk";
import type { PathPaymentQuoteResponse, SignedPathPaymentQuote } from "./types.js";

export const QUOTE_PAYLOAD_VERSION = "delego.path-payment-quote.v1";

export interface QuoteSigner {
  readonly keyId: string;
  getPublicKey(): Promise<string>;
  sign(payload: Buffer): Promise<Buffer>;
}

export class StellarKeypairQuoteSigner implements QuoteSigner {
  private readonly keypair: Keypair;

  constructor(secret: string, readonly keyId = "path-quote-oracle") {
    this.keypair = Keypair.fromSecret(secret);
  }

  async getPublicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  async sign(payload: Buffer): Promise<Buffer> {
    return this.keypair.sign(payload);
  }
}

export interface QuotePayloadFields {
  quoteId: string;
  issuedAt: string;
  destinationAsset: string;
  quote: PathPaymentQuoteResponse;
}

export function buildQuotePayload({ quoteId, issuedAt, destinationAsset, quote }: QuotePayloadFields): string {
  return [
    QUOTE_PAYLOAD_VERSION,
    `quoteId=${quoteId}`,
    `issuedAt=${issuedAt}`,
    `validUntil=${quote.validUntil}`,
    `sourceAsset=${quote.sourceAsset}`,
    `sourceAmountMax=${quote.sourceAmountMax}`,
    `destinationAsset=${destinationAsset}`,
    `destinationAmount=${quote.destinationAmount}`,
    `path=${quote.path.join(",")}`,
  ].join("\n");
}

export async function signQuote(signer: QuoteSigner, fields: QuotePayloadFields): Promise<SignedPathPaymentQuote> {
  const signedPayload = buildQuotePayload(fields);
  const signature = await signer.sign(Buffer.from(signedPayload, "utf8"));
  return {
    quote: fields.quote,
    quoteId: fields.quoteId,
    destinationAsset: fields.destinationAsset,
    issuedAt: fields.issuedAt,
    signedPayload,
    signature: signature.toString("base64"),
    signerPublicKey: await signer.getPublicKey(),
    signerKeyId: signer.keyId,
  };
}

export type QuoteVerification = { valid: true } | { valid: false; reason: string };

/**
 * Verifies a quote presented back at settlement time.
 *
 * `trustedPublicKey` must come from configuration, never from the quote
 * itself, otherwise anyone could self-sign a quote. The payload is rebuilt
 * from the quote fields so a tampered field fails verification even if the
 * original `signedPayload` string is left intact.
 */
export function verifySignedQuote(
  signed: SignedPathPaymentQuote,
  trustedPublicKey: string,
  now: Date = new Date()
): QuoteVerification {
  const expected = buildQuotePayload(signed);
  if (expected !== signed.signedPayload) return { valid: false, reason: "payload does not match quote fields" };

  let ok = false;
  try {
    ok = Keypair.fromPublicKey(trustedPublicKey).verify(
      Buffer.from(expected, "utf8"),
      Buffer.from(signed.signature, "base64")
    );
  } catch {
    ok = false;
  }
  if (!ok) return { valid: false, reason: "invalid signature" };
  if (now.getTime() > Date.parse(signed.quote.validUntil)) return { valid: false, reason: "quote expired" };
  return { valid: true };
}
