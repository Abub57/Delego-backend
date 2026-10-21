/**
 * Guaranteed path-payment quotes: a buyer settles a merchant invoice in an
 * alternative asset (XLM, EURC, …) via Horizon strict-receive paths.
 *
 * Assets are written as "XLM" (native) or "CODE:ISSUER". Amounts are decimal
 * strings in asset units with at most 7 fractional digits (Horizon format).
 */

export interface PathPaymentQuoteRequest {
  /** Candidate assets the buyer can pay with (1-15). */
  sourceAssets: string[];
  /** The asset the merchant must receive. */
  destinationAsset: string;
  /** Exact amount the merchant must receive. */
  destinationAmount: string;
  /** Max acceptable slippage in percent, 0-5. Default 0.5. */
  slippageTolerancePct?: number;
}

export interface PathPaymentQuoteResponse {
  sourceAsset: string;
  /** Use as `sendMax` in pathPaymentStrictReceive. Includes slippage. */
  sourceAmountMax: string;
  destinationAmount: string;
  /** Intermediate hops, excluding source and destination. */
  path: string[];
  /** Cost of the full trade vs. the marginal (spot) rate, in percent. */
  estimatedPriceImpactPct: number;
  validUntil: string;
}

/** A quote plus the oracle signature that makes it binding until `validUntil`. */
export interface SignedPathPaymentQuote {
  quote: PathPaymentQuoteResponse;
  quoteId: string;
  destinationAsset: string;
  issuedAt: string;
  /** Exact bytes that were signed (UTF-8), for independent verification. */
  signedPayload: string;
  /** Base64 Ed25519 signature over `signedPayload`. */
  signature: string;
  signerPublicKey: string;
  signerKeyId: string;
}

/** Why a candidate source asset produced no quote. */
export interface RejectedSourceAsset {
  sourceAsset: string;
  reason: string;
}

export interface PathQuoteResult {
  best: SignedPathPaymentQuote;
  rejected: RejectedSourceAsset[];
}
