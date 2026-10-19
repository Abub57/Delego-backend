/**
 * Asset and amount parsing for path quotes. Amounts are handled as BigInt
 * stroops (1 unit = 10^7 stroops) so no float ever touches a price.
 */

import { StrKey } from "@stellar/stellar-sdk";

export const STROOPS_PER_UNIT = 10_000_000n;
const INT64_MAX = 9_223_372_036_854_775_807n;
const AMOUNT_PATTERN = /^(\d{1,12})(?:\.(\d{1,7}))?$/;
const ASSET_CODE_PATTERN = /^[A-Za-z0-9]{1,12}$/;

export class QuoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteValidationError";
  }
}

export interface ParsedAsset {
  /** "XLM" or "CODE:ISSUER" — the form used in requests and responses. */
  canonical: string;
  /** Horizon query form: "native" or "CODE:ISSUER". */
  horizon: string;
  type: "native" | "credit_alphanum4" | "credit_alphanum12";
  code?: string;
  issuer?: string;
}

export function parseAsset(input: string): ParsedAsset {
  const value = input.trim();
  if (value === "XLM" || value === "native") {
    return { canonical: "XLM", horizon: "native", type: "native" };
  }
  const [code, issuer, extra] = value.split(":");
  if (extra !== undefined || !code || !issuer) {
    throw new QuoteValidationError(`Invalid asset "${input}": expected "XLM" or "CODE:ISSUER"`);
  }
  if (!ASSET_CODE_PATTERN.test(code)) {
    throw new QuoteValidationError(`Invalid asset code "${code}"`);
  }
  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    throw new QuoteValidationError(`Invalid issuer for ${code}: ${issuer}`);
  }
  return {
    canonical: `${code}:${issuer}`,
    horizon: `${code}:${issuer}`,
    type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
    code,
    issuer,
  };
}

/** Converts a Horizon asset record (`*_asset_type`, `*_asset_code`, …) to canonical form. */
export function canonicalFromHorizon(type: string, code?: string, issuer?: string): string {
  return type === "native" ? "XLM" : `${code}:${issuer}`;
}

export function parseAmount(value: string, field = "amount"): bigint {
  const match = AMOUNT_PATTERN.exec(value.trim());
  if (!match) {
    throw new QuoteValidationError(`${field} must be a decimal with at most 7 fractional digits, got "${value}"`);
  }
  const stroops = BigInt(match[1]) * STROOPS_PER_UNIT + BigInt((match[2] ?? "").padEnd(7, "0"));
  if (stroops > INT64_MAX) throw new QuoteValidationError(`${field} exceeds the Stellar int64 limit`);
  return stroops;
}

export function formatAmount(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_UNIT;
  const fraction = (stroops % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
