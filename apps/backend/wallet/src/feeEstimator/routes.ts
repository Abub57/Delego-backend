/**
 * Dynamic Fee Estimator HTTP Routes
 * Issue #364
 *
 * GET  /api/v1/fee/recommendation – Get dynamic fee recommendations and congestion level
 * POST /api/v1/fee/refresh        – Force refresh fee statistics from Horizon into Redis
 * GET  /api/v1/fee/metrics        – Get fee metrics & congestion stats
 */
import { route, json, type Route } from "@delegolabs/utils";
import { getRedisConnection } from "../queue/txQueue.js";
import { DynamicFeeEstimator } from "../feeEstimator/dynamicFeeEstimator.js";
import type { DynamicFeeUrgency } from "@delegolabs/types";

let feeEstimatorInstance: DynamicFeeEstimator | null = null;

function getFeeEstimator(): DynamicFeeEstimator {
  if (!feeEstimatorInstance) {
    const redis = getRedisConnection();
    const horizonUrl =
      process.env.STELLAR_NETWORK === "mainnet"
        ? (process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org")
        : (process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org");
    feeEstimatorInstance = new DynamicFeeEstimator(redis, horizonUrl);
  }
  return feeEstimatorInstance;
}

export function registerFeeEstimatorRoutes(): Route[] {
  return [
    // GET /api/v1/fee/recommendation
    route("GET", "/api/v1/fee/recommendation", async (req, res) => {
      try {
        const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
        const horizonParam = url.searchParams.get("horizonUrl") ?? undefined;
        const urgencyParam = (url.searchParams.get("urgency") as DynamicFeeUrgency | null) ?? undefined;

        const estimator = getFeeEstimator();
        const recommendation = await estimator.getFeeRecommendation(horizonParam);

        if (urgencyParam) {
          const feeStroops = await estimator.getFeeForUrgency(urgencyParam, horizonParam);
          json(res, 200, {
            data: {
              ...recommendation,
              selectedUrgency: urgencyParam,
              feeStroops,
            },
            error: null,
          });
          return;
        }

        json(res, 200, { data: recommendation, error: null });
      } catch (err: any) {
        json(res, 500, {
          data: null,
          error: { code: "FEE_ESTIMATION_ERROR", message: err.message },
        });
      }
    }),

    // POST /api/v1/fee/refresh
    route("POST", "/api/v1/fee/refresh", async (req, res) => {
      try {
        const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
        const horizonParam = url.searchParams.get("horizonUrl") ?? undefined;

        const estimator = getFeeEstimator();
        const recommendation = await estimator.refreshFeeStats(horizonParam);

        json(res, 200, {
          data: {
            message: "Fee statistics refreshed successfully",
            recommendation,
          },
          error: null,
        });
      } catch (err: any) {
        json(res, 500, {
          data: null,
          error: { code: "FEE_REFRESH_ERROR", message: err.message },
        });
      }
    }),

    // GET /api/v1/fee/metrics
    route("GET", "/api/v1/fee/metrics", async (_req, res) => {
      try {
        const estimator = getFeeEstimator();
        const metrics = await estimator.getMetrics();
        json(res, 200, { data: metrics, error: null });
      } catch (err: any) {
        json(res, 500, {
          data: null,
          error: { code: "FEE_METRICS_ERROR", message: err.message },
        });
      }
    }),
  ];
}
