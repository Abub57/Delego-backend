/**
 * POST /api/v1/merchants/:merchantId/domain-verification
 *
 * Body: { "domain": "shop.example.com" }   (optional — omit to re-check the
 * current home domain)
 *
 * Sets the merchant's home domain and runs SEP-1 validation immediately.
 * Only the merchant owner may call it, at most once per minute per merchant,
 * because each call makes the server fetch a merchant-supplied URL.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, readBodyWithLimit, route, type Route } from "@delegolabs/utils";
import { sequelize } from "../db.js";
import { getRedisConnection } from "../queue/txQueue.js";
import {
  DomainValidationError,
  DomainValidationService,
  DomainValidator,
  MerchantNotFoundError,
} from "./domainValidationService.js";
import { SequelizeMerchantDomainStore, type MerchantDomainStore } from "./merchantDomainStore.js";
import type { RedisSetNx } from "./reverificationScheduler.js";

const RATE_LIMIT_SECONDS = 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { data: null, error: { code, message } });
}

export interface DomainVerificationRouteDeps {
  service: Pick<DomainValidationService, "verifyMerchant">;
  store: Pick<MerchantDomainStore, "getMerchant">;
  rateLimiter: RedisSetNx;
}

export function createDomainVerificationHandler(deps: DomainVerificationRouteDeps) {
  return async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> => {
    const userId = (req as IncomingMessage & { userId?: string }).userId;
    if (!userId) {
      sendError(res, 401, "UNAUTHORIZED", "Authentication required");
      return;
    }
    const merchantId = params.merchantId ?? "";
    if (!UUID_PATTERN.test(merchantId)) {
      sendError(res, 400, "VALIDATION_ERROR", "merchantId must be a UUID");
      return;
    }

    let domain: string | undefined;
    try {
      const raw = await readBodyWithLimit(req);
      const body = raw ? (JSON.parse(raw) as { domain?: unknown }) : {};
      if (body.domain !== undefined && typeof body.domain !== "string") {
        sendError(res, 400, "VALIDATION_ERROR", "domain must be a string");
        return;
      }
      domain = body.domain;
    } catch {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid JSON body");
      return;
    }

    try {
      const merchant = await deps.store.getMerchant(merchantId);
      // 404 rather than 403 so merchant ids can't be probed.
      if (!merchant || merchant.ownerUserId !== userId) {
        sendError(res, 404, "NOT_FOUND", "Merchant not found");
        return;
      }

      const allowed = await deps.rateLimiter.set(
        `merchant-domain-verify:${merchantId}`, "1", "EX", RATE_LIMIT_SECONDS, "NX"
      );
      if (allowed !== "OK") {
        res.setHeader("Retry-After", String(RATE_LIMIT_SECONDS));
        sendError(res, 429, "RATE_LIMITED", "Domain verification was requested recently; try again shortly");
        return;
      }

      const result = await deps.service.verifyMerchant(merchantId, domain);
      json(res, 200, { data: result, error: null });
    } catch (err) {
      if (err instanceof DomainValidationError) {
        sendError(res, 400, "INVALID_DOMAIN", err.message);
      } else if (err instanceof MerchantNotFoundError) {
        sendError(res, 404, "NOT_FOUND", "Merchant not found");
      } else {
        sendError(res, 500, "INTERNAL_ERROR", err instanceof Error ? err.message : "Domain verification failed");
      }
    }
  };
}

let defaultService: DomainValidationService | null = null;

/** Shared, lazily built service used by the route and the daily cron. */
export function getDomainValidationService(): DomainValidationService {
  defaultService ??= new DomainValidationService({
    store: new SequelizeMerchantDomainStore(sequelize),
    validator: new DomainValidator({
      networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? process.env.SOROBAN_NETWORK_PASSPHRASE,
    }),
  });
  return defaultService;
}

export function registerMerchantDomainRoutes(): Route[] {
  let handler: ReturnType<typeof createDomainVerificationHandler> | null = null;
  return [
    route("POST", "/api/v1/merchants/:merchantId/domain-verification", (req, res, params) => {
      handler ??= createDomainVerificationHandler({
        service: getDomainValidationService(),
        store: new SequelizeMerchantDomainStore(sequelize),
        rateLimiter: getRedisConnection() as unknown as RedisSetNx,
      });
      return handler(req, res, params);
    }),
  ];
}
