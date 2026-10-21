/**
 * HTTP routes for storage key rotation (#400).
 *
 *   GET  /api/v1/storage/rotation            — rotation state + metrics
 *   POST /api/v1/storage/rotation            — trigger a rotation now
 *   POST /api/v1/storage/rotation/complete   — revoke the retiring key early
 *   GET  /api/v1/storage/rotation/alerts     — current key-expiry alerts
 */

import { json, route, type Route } from "@delegolabs/utils";
import type { StorageRotationService } from "./rotationService.js";

export function registerStorageRotationRoutes(service: StorageRotationService): Route[] {
  return [
    route("GET", "/api/v1/storage/rotation", async (_req, res) => {
      json(res, 200, {
        data: { rotation: service.getRotationState(), metrics: service.getMetrics() },
        error: null,
      });
    }),

    route("POST", "/api/v1/storage/rotation", async (_req, res) => {
      try {
        const result = await service.rotate();
        json(res, 200, { data: result, error: null });
      } catch (err) {
        json(res, 409, {
          data: null,
          error: { code: "ROTATION_FAILED", message: (err as Error).message },
        });
      }
    }),

    route("POST", "/api/v1/storage/rotation/complete", async (_req, res) => {
      const completed = await service.completeRotation();
      if (!completed) {
        json(res, 409, {
          data: null,
          error: {
            code: "NOTHING_TO_COMPLETE",
            message: "no rotation in grace period or grace not elapsed",
          },
        });
        return;
      }
      json(res, 200, { data: completed, error: null });
    }),

    route("GET", "/api/v1/storage/rotation/alerts", async (_req, res) => {
      json(res, 200, { data: service.evaluateAlerts(), error: null });
    }),
  ];
}
