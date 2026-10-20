/**
 * Path-payment quote proxy.
 *
 * For an invoice the merchant must receive in `destinationAsset`, quotes how
 * much of each candidate `sourceAsset` the buyer must send, validates that
 * the liquidity is deep enough, and returns an oracle-signed quote the
 * backend honours for 60 seconds.
 *
 * Price impact: Horizon is asked for paths twice in parallel, once for the
 * full amount and once for a small probe amount. The probe's rate
 * approximates the marginal (spot) rate across the same order books and
 * pools, so
 *
 *     impact = (fullSource / fullDest) / (probeSource / probeDest) - 1
 *
 * is the extra cost of walking the books for the whole trade. Everything is
 * computed with BigInt stroops.
 *
 * Slippage: `sourceAmountMax = ceil(fullSource × (1 + slippage))`, which the
 * buyer uses as `sendMax`, so the merchant still receives the exact amount
 * if the market moves within tolerance before execution.
 */

import { randomUUID } from "node:crypto";
import { createLogger, type Logger } from "@delegolabs/utils";
import {
  QuoteValidationError,
  canonicalFromHorizon,
  ceilDiv,
  formatAmount,
  parseAmount,
  parseAsset,
  type ParsedAsset,
} from "./assets.js";
import type { HorizonPathRecord, HorizonPathsClient } from "./horizonClient.js";
import { signQuote, type QuoteSigner } from "./quoteSigner.js";
import type {
  PathPaymentQuoteRequest,
  PathPaymentQuoteResponse,
  PathQuoteResult,
  RejectedSourceAsset,
} from "./types.js";

const log = createLogger("wallet:path-quotes", process.env.LOG_LEVEL ?? "info");

export const DEFAULT_SLIPPAGE_TOLERANCE_PCT = 0.5;
export const MAX_SLIPPAGE_TOLERANCE_PCT = 5;
export const DEFAULT_MAX_PRICE_IMPACT_PCT = 2.5;
export const QUOTE_VALIDITY_MS = 60_000;
/** Horizon's limit on `source_assets`. */
export const MAX_SOURCE_ASSETS = 15;

/** Fixed-point scale for percentages: 1% = 10_000 ppm-of-100. */
const PCT_SCALE = 10_000n;
/** Probe = destination / 1000, but never below 0.001 units. */
const PROBE_DIVISOR = 1_000n;
const MIN_PROBE_STROOPS = 10_000n;

export class NoViableQuoteError extends Error {
  constructor(readonly rejected: RejectedSourceAsset[]) {
    super(
      `No viable path: ${rejected.map((r) => `${r.sourceAsset} (${r.reason})`).join("; ") || "no candidates"}`
    );
    this.name = "NoViableQuoteError";
  }
}

export interface PathQuoteServiceOptions {
  horizon: HorizonPathsClient;
  signer: QuoteSigner;
  /** Reject quotes whose price impact exceeds this. Default 2.5%. */
  maxPriceImpactPct?: number;
  now?: () => Date;
  newQuoteId?: () => string;
  logger?: Logger;
}

interface ValidatedRequest {
  sources: ParsedAsset[];
  destination: ParsedAsset;
  destinationStroops: bigint;
  slippagePct: number;
}

interface Candidate {
  source: ParsedAsset;
  sourceStroops: bigint;
  path: string[];
  priceImpactPct: number;
}

export function validateQuoteRequest(request: PathPaymentQuoteRequest): ValidatedRequest {
  if (!request || typeof request !== "object") throw new QuoteValidationError("Request body is required");
  if (!Array.isArray(request.sourceAssets) || request.sourceAssets.length === 0) {
    throw new QuoteValidationError("sourceAssets must be a non-empty array");
  }
  if (request.sourceAssets.length > MAX_SOURCE_ASSETS) {
    throw new QuoteValidationError(`sourceAssets accepts at most ${MAX_SOURCE_ASSETS} assets`);
  }
  if (typeof request.destinationAsset !== "string" || typeof request.destinationAmount !== "string") {
    throw new QuoteValidationError("destinationAsset and destinationAmount must be strings");
  }

  const destination = parseAsset(request.destinationAsset);
  const destinationStroops = parseAmount(request.destinationAmount, "destinationAmount");
  if (destinationStroops <= 0n) throw new QuoteValidationError("destinationAmount must be positive");

  const seen = new Set<string>();
  const sources: ParsedAsset[] = [];
  for (const raw of request.sourceAssets) {
    if (typeof raw !== "string") throw new QuoteValidationError("sourceAssets must contain strings");
    const asset = parseAsset(raw);
    if (asset.canonical === destination.canonical) {
      throw new QuoteValidationError(`${asset.canonical} is the destination asset; pay it directly instead`);
    }
    if (!seen.has(asset.canonical)) {
      seen.add(asset.canonical);
      sources.push(asset);
    }
  }

  const slippagePct = request.slippageTolerancePct ?? DEFAULT_SLIPPAGE_TOLERANCE_PCT;
  if (typeof slippagePct !== "number" || !Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct > MAX_SLIPPAGE_TOLERANCE_PCT) {
    throw new QuoteValidationError(`slippageTolerancePct must be between 0 and ${MAX_SLIPPAGE_TOLERANCE_PCT}`);
  }
  return { sources, destination, destinationStroops, slippagePct };
}

/** ceil(amount × (1 + pct/100)), with pct resolved to 0.0001% precision. */
export function applySlippage(sourceStroops: bigint, slippagePct: number): bigint {
  const scaledPct = BigInt(Math.round(slippagePct * Number(PCT_SCALE)));
  const denominator = 100n * PCT_SCALE;
  return ceilDiv(sourceStroops * (denominator + scaledPct), denominator);
}

/**
 * Percentage by which the full trade's rate exceeds the probe (spot) rate,
 * rounded to 0.01% and floored at 0 (probe rounding can make it slightly negative).
 */
export function estimatePriceImpactPct(
  full: { source: bigint; dest: bigint },
  probe: { source: bigint; dest: bigint }
): number {
  if (probe.source <= 0n || full.dest <= 0n) throw new Error("Cannot estimate price impact from empty amounts");
  const scale = 100n * PCT_SCALE;
  const ratio = (full.source * probe.dest * scale) / (probe.source * full.dest);
  const impact = ratio - scale; // in units of 1/PCT_SCALE percent
  if (impact <= 0n) return 0;
  return Math.round(Number(impact) / 100) / 100;
}

function probeAmount(destinationStroops: bigint): bigint {
  const probe = destinationStroops / PROBE_DIVISOR;
  if (probe >= MIN_PROBE_STROOPS) return probe;
  return destinationStroops < MIN_PROBE_STROOPS ? destinationStroops : MIN_PROBE_STROOPS;
}

/** Cheapest record per source asset, keyed by canonical source asset. */
function cheapestBySource(records: HorizonPathRecord[], destination: ParsedAsset): Map<string, HorizonPathRecord> {
  const best = new Map<string, HorizonPathRecord>();
  for (const record of records) {
    const dest = canonicalFromHorizon(
      record.destination_asset_type,
      record.destination_asset_code,
      record.destination_asset_issuer
    );
    if (dest !== destination.canonical) continue;
    const source = canonicalFromHorizon(record.source_asset_type, record.source_asset_code, record.source_asset_issuer);
    const current = best.get(source);
    if (!current || parseAmount(record.source_amount) < parseAmount(current.source_amount)) {
      best.set(source, record);
    }
  }
  return best;
}

export class PathQuoteService {
  private readonly horizon: HorizonPathsClient;
  private readonly signer: QuoteSigner;
  private readonly maxPriceImpactPct: number;
  private readonly now: () => Date;
  private readonly newQuoteId: () => string;
  private readonly log: Logger;

  constructor(options: PathQuoteServiceOptions) {
    this.horizon = options.horizon;
    this.signer = options.signer;
    this.maxPriceImpactPct = options.maxPriceImpactPct ?? DEFAULT_MAX_PRICE_IMPACT_PCT;
    this.now = options.now ?? (() => new Date());
    this.newQuoteId = options.newQuoteId ?? randomUUID;
    this.log = options.logger ?? log;
  }

  /**
   * Returns a signed quote for the viable source asset with the lowest price
   * impact (ties go to the asset listed first), plus why the others failed.
   *
   * @throws QuoteValidationError for a malformed request
   * @throws NoViableQuoteError when no source asset has acceptable liquidity
   */
  async getQuote(request: PathPaymentQuoteRequest): Promise<PathQuoteResult> {
    const req = validateQuoteRequest(request);
    const probeStroops = probeAmount(req.destinationStroops);
    const query = {
      sourceAssets: req.sources.map((s) => s.horizon),
      destinationAsset: { type: req.destination.type, code: req.destination.code, issuer: req.destination.issuer },
    };

    const [fullRecords, probeRecords] = await Promise.all([
      this.horizon.strictReceivePaths({ ...query, destinationAmount: formatAmount(req.destinationStroops) }),
      this.horizon.strictReceivePaths({ ...query, destinationAmount: formatAmount(probeStroops) }),
    ]);
    const full = cheapestBySource(fullRecords, req.destination);
    const probe = cheapestBySource(probeRecords, req.destination);

    const candidates: Candidate[] = [];
    const rejected: RejectedSourceAsset[] = [];
    for (const source of req.sources) {
      const candidate = this.evaluate(source, full.get(source.canonical), probe.get(source.canonical), req, probeStroops);
      if ("reason" in candidate) rejected.push(candidate);
      else candidates.push(candidate);
    }

    // Stable sort keeps the caller's preference order on ties.
    const best = [...candidates].sort((a, b) => a.priceImpactPct - b.priceImpactPct)[0];
    if (!best) throw new NoViableQuoteError(rejected);

    const issuedAt = this.now();
    const quote: PathPaymentQuoteResponse = {
      sourceAsset: best.source.canonical,
      sourceAmountMax: formatAmount(applySlippage(best.sourceStroops, req.slippagePct)),
      destinationAmount: formatAmount(req.destinationStroops),
      path: best.path,
      estimatedPriceImpactPct: best.priceImpactPct,
      validUntil: new Date(issuedAt.getTime() + QUOTE_VALIDITY_MS).toISOString(),
    };
    const signed = await signQuote(this.signer, {
      quoteId: this.newQuoteId(),
      issuedAt: issuedAt.toISOString(),
      destinationAsset: req.destination.canonical,
      quote,
    });

    this.log.info("Issued path payment quote", {
      quoteId: signed.quoteId,
      sourceAsset: quote.sourceAsset,
      destinationAsset: signed.destinationAsset,
      destinationAmount: quote.destinationAmount,
      priceImpactPct: quote.estimatedPriceImpactPct,
      rejected: rejected.length,
    });
    return { best: signed, rejected };
  }

  private evaluate(
    source: ParsedAsset,
    fullRecord: HorizonPathRecord | undefined,
    probeRecord: HorizonPathRecord | undefined,
    req: ValidatedRequest,
    probeStroops: bigint
  ): Candidate | RejectedSourceAsset {
    const reject = (reason: string): RejectedSourceAsset => ({ sourceAsset: source.canonical, reason });
    if (!fullRecord) return reject("no path with enough liquidity for the full amount");
    if (!probeRecord) return reject("unable to estimate price impact");

    const fullDest = parseAmount(fullRecord.destination_amount);
    if (fullDest !== req.destinationStroops) return reject("Horizon returned a path for a different amount");
    const sourceStroops = parseAmount(fullRecord.source_amount);
    if (sourceStroops <= 0n) return reject("Horizon returned a non-positive source amount");

    const probeSource = parseAmount(probeRecord.source_amount);
    const probeDest = parseAmount(probeRecord.destination_amount);
    if (probeSource <= 0n || probeDest !== probeStroops) return reject("unable to estimate price impact");

    const priceImpactPct = estimatePriceImpactPct(
      { source: sourceStroops, dest: fullDest },
      { source: probeSource, dest: probeDest }
    );
    if (priceImpactPct > this.maxPriceImpactPct) {
      return reject(`price impact ${priceImpactPct}% exceeds ${this.maxPriceImpactPct}%`);
    }

    return {
      source,
      sourceStroops,
      priceImpactPct,
      path: (fullRecord.path ?? []).map((hop) => canonicalFromHorizon(hop.asset_type, hop.asset_code, hop.asset_issuer)),
    };
  }
}
