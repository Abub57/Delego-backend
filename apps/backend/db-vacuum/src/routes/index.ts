/**
 * HTTP surface for the vacuum/bloat worker.
 * Issue #382 — Automated Database Vacuum and Bloat Monitoring Worker.
 */
import { json, route, type Route } from "@delegolabs/utils";
import type { DatabaseVacuumService } from "../service.js";
import { VacuumRunInProgressError } from "../service.js";

export function registerRoutes(service: DatabaseVacuumService): Route[] {
  return [
    route("GET", "/api/v1/db-vacuum/config", async (_req, res) => {
      json(res, 200, { data: service.config(), error: null });
    }),

    route("GET", "/api/v1/db-vacuum/bloat", async (_req, res) => {
      // Fresh scan rather than the last cached one, so the endpoint reflects
      // the database as it is right now.
      const assessments = await service.scan();
      json(res, 200, {
        data: { count: assessments.length, assessments },
        error: null,
      });
    }),

    route("GET", "/api/v1/db-vacuum/metrics", async (_req, res) => {
      json(res, 200, { data: service.metrics(), error: null });
    }),

    route("POST", "/api/v1/db-vacuum/run", async (_req, res) => {
      try {
        const summary = await service.runOnce();
        json(res, 200, { data: summary, error: null });
      } catch (err) {
        if (err instanceof VacuumRunInProgressError) {
          json(res, 409, {
            data: null,
            error: { code: "RUN_IN_PROGRESS", message: err.message },
          });
          return;
        }
        throw err;
      }
    }),

    route("GET", "/api/v1/db-vacuum/runs", async (_req, res) => {
      const summary = service.lastRun();
      json(res, 200, { data: summary, error: null });
    }),
  ];
}
