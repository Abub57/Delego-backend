/**
 * HTTP route handlers for product search.
 * Issue #263: POST /api/v1/search/products — semantic vector search endpoint.
 * Issue #389: GET /api/v1/search/embedding-cache/metrics — embedding cache metrics.
 */

import type { RouteHandler } from "@delegolabs/utils";
import { badRequest, internalError, success } from "../errors.js";
import { readJsonBody } from "../request.js";
import { searchProducts } from "./service.js";
import { getEmbeddingCacheMetrics } from "./embeddings.js";
import type { SearchProductsInput } from "./types.js";

/**
 * POST /api/v1/search/products
 *
 * Body: SearchProductsInput
 * Response: { data: SearchProductResult[] }
 */
export const searchProductsHandler: RouteHandler = async (req, res, _params) => {
  let body: SearchProductsInput;
  try {
    body = (await readJsonBody(req)) as SearchProductsInput;
  } catch {
    return badRequest(res, "Invalid JSON body", req);
  }

  if (!body.query || typeof body.query !== "string" || body.query.trim().length === 0) {
    return badRequest(res, "query is required and must be a non-empty string", req);
  }

  if (body.limit !== undefined) {
    const limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return badRequest(res, "limit must be an integer between 1 and 50", req);
    }
    body.limit = limit;
  }

  if (
    body.minMerchantRating !== undefined &&
    (typeof body.minMerchantRating !== "number" ||
      body.minMerchantRating < 0 ||
      body.minMerchantRating > 5)
  ) {
    return badRequest(res, "minMerchantRating must be a number between 0 and 5", req);
  }

  try {
    const results = await searchProducts(body);
    return success(res, results, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return internalError(res, error.message, req, { stack: error.stack });
  }
};

/**
 * GET /api/v1/search/embedding-cache/metrics
 *
 * Returns embedding cache metrics including hit rate, cache size, and evictions.
 */
export const embeddingCacheMetricsHandler: RouteHandler = async (_req, res) => {
  try {
    const metrics = getEmbeddingCacheMetrics();
    return success(res, metrics);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return internalError(res, error.message);
  }
};
