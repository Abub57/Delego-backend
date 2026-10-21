/**
 * POST /api/v1/payments/path-quotes
 *
 * Body: PathPaymentQuoteRequest. Returns a signed quote, guaranteed for 60s:
 *   200 { data: { quote: SignedPathPaymentQuote, rejected: [...] } }
 *   400 malformed request · 422 no viable path · 502 Horizon unavailable
 *   503 quote signing key not configured
 *
 * Env: STELLAR_HORIZON_URL / STELLAR_NETWORK, PATH_QUOTE_ORACLE_SECRET,
 *      PATH_QUOTE_MAX_PRICE_IMPACT_PCT (default 2.5).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, readBodyWithLimit, route, type Route } from "@delegolabs/utils";
import { QuoteValidationError } from "./assets.js";
import { HorizonRequestError, PooledHorizonClient } from "./horizonClient.js";
import { NoViableQuoteError, PathQuoteService } from "./pathQuoteService.js";
import { StellarKeypairQuoteSigner } from "./quoteSigner.js";
import type { PathPaymentQuoteRequest } from "./types.js";

function sendError(res: ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  json(res, status, { data: null, error: { code, message, ...(details ? { details } : {}) } });
}

export function createPathQuoteHandler(getService: () => Pick<PathQuoteService, "getQuote"> | null) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const service = getService();
    if (!service) {
      sendError(res, 503, "QUOTES_UNAVAILABLE", "Path payment quoting is not configured");
      return;
    }

    let body: PathPaymentQuoteRequest;
    try {
      body = JSON.parse((await readBodyWithLimit(req, 16 * 1024)) || "null") as PathPaymentQuoteRequest;
    } catch {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid JSON body");
      return;
    }

    try {
      const result = await service.getQuote(body);
      json(res, 200, { data: { quote: result.best, rejected: result.rejected }, error: null });
    } catch (err) {
      if (err instanceof QuoteValidationError) {
        sendError(res, 400, "VALIDATION_ERROR", err.message);
      } else if (err instanceof NoViableQuoteError) {
        sendError(res, 422, "NO_VIABLE_PATH", err.message, err.rejected);
      } else if (err instanceof HorizonRequestError) {
        sendError(res, 502, "HORIZON_UNAVAILABLE", err.message);
      } else {
        sendError(res, 500, "INTERNAL_ERROR", err instanceof Error ? err.message : "Quote failed");
      }
    }
  };
}

let sharedService: PathQuoteService | null | undefined;
let sharedHorizon: PooledHorizonClient | null = null;

function horizonUrl(): string {
  if (process.env.STELLAR_HORIZON_URL) return process.env.STELLAR_HORIZON_URL;
  return process.env.STELLAR_NETWORK === "mainnet" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";
}

/** One pooled Horizon client and signer per process; null when unconfigured. */
export function getPathQuoteService(): PathQuoteService | null {
  if (sharedService !== undefined) return sharedService;
  const secret = process.env.PATH_QUOTE_ORACLE_SECRET;
  if (!secret) {
    sharedService = null;
    return null;
  }
  sharedHorizon = new PooledHorizonClient(horizonUrl());
  sharedService = new PathQuoteService({
    horizon: sharedHorizon,
    signer: new StellarKeypairQuoteSigner(secret),
    maxPriceImpactPct: process.env.PATH_QUOTE_MAX_PRICE_IMPACT_PCT
      ? Number(process.env.PATH_QUOTE_MAX_PRICE_IMPACT_PCT)
      : undefined,
  });
  return sharedService;
}

/** Releases pooled Horizon sockets on shutdown. */
export function closePathQuoteService(): void {
  sharedHorizon?.close();
}

export function registerPathQuoteRoutes(): Route[] {
  return [route("POST", "/api/v1/payments/path-quotes", createPathQuoteHandler(getPathQuoteService))];
}
