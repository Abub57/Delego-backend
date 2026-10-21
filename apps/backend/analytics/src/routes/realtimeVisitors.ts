/** GET /api/v1/analytics/realtime-visitors?merchantId=<uuid> */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../../../gateway/middleware/auth.js";
import { forbidden, sendApiError, unauthorized } from "../../../gateway/src/errors.js";
import { sequelize } from "../db.js";
import { getRedisClient } from "../redisClient.js";
import { isMerchantOwner } from "../services/merchantRevenueService.js";
import { RealtimeVisitorsService } from "../services/realtimeVisitorsService.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RealtimeVisitorsHandlerDeps {
  service: Pick<RealtimeVisitorsService, "getRealtimeVisitors">;
  isOwner: (merchantId: string, userId: string) => Promise<boolean>;
}

export function createRealtimeVisitorsHandler(deps: RealtimeVisitorsHandlerDeps) {
  return async function getRealtimeVisitorsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = extractAuth(req);
    const userId = auth.userId;
    if (!userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const merchantId = url.searchParams.get("merchantId")?.trim() ?? "";
    if (!UUID_PATTERN.test(merchantId)) {
      sendApiError(res, 400, "VALIDATION_ERROR", "merchantId must be a UUID", req);
      return;
    }

    try {
      const isAdmin = getAuthenticatedUserContext(req)?.roles.includes("admin") ?? false;
      if (!isAdmin && !(await deps.isOwner(merchantId, userId))) {
        forbidden(res, "You do not have access to this merchant's analytics", req);
        return;
      }

      const result = await deps.service.getRealtimeVisitors(merchantId);
      json(res, 200, { data: result, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch realtime visitors";
      sendApiError(res, 500, "INTERNAL_ERROR", message, req);
    }
  };
}

let defaultHandler: ReturnType<typeof createRealtimeVisitorsHandler> | null = null;

/** Lazily construct Redis-backed dependencies on the first request. */
export function getRealtimeVisitorsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  defaultHandler ??= createRealtimeVisitorsHandler({
    service: new RealtimeVisitorsService(getRedisClient()),
    isOwner: (merchantId, userId) => isMerchantOwner(sequelize, merchantId, userId),
  });
  return defaultHandler(req, res);
}
