/**
 * Storefront API routes (Issue #112).
 *
 * High-throughput public REST API allowing buyers and agents to browse
 * a merchant's inventory with:
 * - Base64 cursor encoding for deterministic pagination on (created_at, id)
 * - Redis caching (60s TTL) with cache invalidation on product updates
 */

import type { Route, RouteHandler } from "@delegolabs/utils";
import { json, createLogger, route } from "@delegolabs/utils";
import { Redis } from "ioredis";
import { encodeCursor, decodeCursor } from "../src/base64Cursor.js";
import type {
  Product,
  StorefrontQueryParams,
  PaginatedProductsResponse,
  ProductSortOption,
} from "@delegolabs/types";

const log = createLogger("gateway:storefront", process.env.LOG_LEVEL ?? "info");

// Redis client singleton
let redisClient: Redis | null = null;

/**
 * Get or initialize Redis client.
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    redisClient = new Redis(redisUrl);
    redisClient.on("error", (err: Error) => log.error("Redis client error", { error: err.message }));
    redisClient.on("connect", () => log.info("Redis client connected"));
  }
  return redisClient;
}

/**
 * Cache key for merchant products list.
 */
export function getProductsCacheKey(merchantId: string, params: StorefrontQueryParams): string {
  const { cursor, limit = 20, category, minPrice, maxPrice, sort = "newest" } = params;
  const paramsHash = [
    cursor ? `cursor=${cursor}` : "",
    `limit=${limit}`,
    category ? `category=${category}` : "",
    minPrice ? `minPrice=${minPrice}` : "",
    maxPrice ? `maxPrice=${maxPrice}` : "",
    `sort=${sort}`,
  ]
    .filter(Boolean)
    .join("&");
  return `storefront:merchant:${merchantId}:products:${paramsHash}`;
}

/**
 * Cache key for individual product.
 */
export function getProductCacheKey(merchantId: string, productId: string): string {
  return `storefront:merchant:${merchantId}:product:${productId}`;
}

/**
 * Invalidate product cache for a merchant.
 */
export async function invalidateProductCache(merchantId: string, productId?: string): Promise<void> {
  const client = getRedisClient();
  if (productId) {
    // Invalidate specific product
    await client.del(getProductCacheKey(merchantId, productId));
  }
  // Invalidate all product list caches for this merchant
  // This could be optimized with a dedicated set key
  await client.del(`storefront:merchant:${merchantId}:products:*`);
}

/**
 * Encode pagination cursor as Base64 from (created_at, id) tuple.
 * Format: base64("created_at|id")
 */
export { encodeCursor };

/**
 * Decode Base64 cursor to (created_at, id) tuple.
 */
export { decodeCursor };

/**
 * Fetch products from the database (stub implementation).
 * Replace with actual database query.
 */
export async function fetchProducts(
  _merchantId: string,
  _params: StorefrontQueryParams,
): Promise<{ items: Product[]; nextCursor: string | null; totalCount: number }> {
  // This would typically query the products database
  // For now, returning a placeholder structure
  return {
    items: [],
    nextCursor: null,
    totalCount: 0,
  };
}

/**
 * Storefront products list handler.
 *
 * GET /api/v1/merchants/:merchantId/products
 *
 * Query params:
 * - cursor: Base64-encoded (created_at, id) for pagination
 * - limit: 1-50, default 20
 * - category: Filter by category
 * - minPrice: Minimum price filter
 * - maxPrice: Maximum price filter
 * - sort: "price_asc" | "price_desc" | "newest"
 */
export const listProductsHandler: RouteHandler = async (req, res, params) => {
  const merchantId = params.merchantId;
  if (!merchantId) {
    json(res, 400, {
      data: null,
      error: { code: "MISSING_MERCHANT_ID", message: "merchantId path parameter is required" },
    });
    return;
  }

  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const query: StorefrontQueryParams = {
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
    category: url.searchParams.get("category") ?? undefined,
    minPrice: url.searchParams.get("minPrice") ?? undefined,
    maxPrice: url.searchParams.get("maxPrice") ?? undefined,
    sort: (url.searchParams.get("sort") as ProductSortOption) ?? "newest",
  };

  // Validate limit
  if (query.limit !== undefined) {
    if (query.limit < 1 || query.limit > 50) {
      json(res, 400, {
        data: null,
        error: { code: "INVALID_LIMIT", message: "limit must be between 1 and 50" },
      });
      return;
    }
  }

  const client = getRedisClient();
  const cacheKey = getProductsCacheKey(merchantId, query);
  const cacheTTL = 60; // 60 seconds

  try {
    // Try to get from cache
    const cached = await client.get(cacheKey);
    if (cached) {
      log.debug("Cache hit for products list", { merchantId, cacheKey });
      const response: PaginatedProductsResponse = JSON.parse(cached);
      json(res, 200, { data: response, error: null });
      return;
    }

    log.debug("Cache miss for products list", { merchantId, cacheKey });

    // Fetch from database
    const result = await fetchProducts(merchantId, query);

    // Cache the result
    await client.setex(cacheKey, cacheTTL, JSON.stringify(result));

    json(res, 200, { data: result, error: null });
  } catch (err) {
    log.error("Failed to fetch products", {
      merchantId,
      error: err instanceof Error ? err.message : String(err),
    });
    json(res, 500, {
      data: null,
      error: { code: "PRODUCTS_FETCH_FAILED", message: err instanceof Error ? err.message : "Failed to fetch products" },
    });
  }
};

/**
 * Get single product handler (for cache invalidation on updates).
 *
 * GET /api/v1/merchants/:merchantId/products/:productId
 */
export const getProductHandler: RouteHandler = async (_req, res, params) => {
  const { merchantId, productId } = params;

  if (!merchantId || !productId) {
    json(res, 400, {
      data: null,
      error: { code: "MISSING_PARAMETERS", message: "merchantId and productId are required" },
    });
    return;
  }

  const client = getRedisClient();
  const cacheKey = getProductCacheKey(merchantId, productId);

  try {
    // Try to get from cache
    const cached = await client.get(cacheKey);
    if (cached) {
      const product: Product = JSON.parse(cached);
      json(res, 200, { data: product, error: null });
      return;
    }

    // Fetch from database (stub)
    const product: Product | null = null; // Replace with actual fetch

    if (!product) {
      json(res, 404, {
        data: null,
        error: { code: "PRODUCT_NOT_FOUND", message: "Product not found" },
      });
      return;
    }

    // Cache the result
    await client.setex(cacheKey, 60, JSON.stringify(product));

    json(res, 200, { data: product, error: null });
  } catch (err) {
    log.error("Failed to fetch product", {
      merchantId,
      productId,
      error: err instanceof Error ? err.message : String(err),
    });
    json(res, 500, {
      data: null,
      error: { code: "PRODUCT_FETCH_FAILED", message: err instanceof Error ? err.message : "Failed to fetch product" },
    });
  }
};

/**
 * Register storefront routes.
 */
export function registerStorefrontRoutes(): Route[] {
  return [
    route("GET", "/api/v1/merchants/:merchantId/products", listProductsHandler),
    route("GET", "/api/v1/merchants/:merchantId/products/:productId", getProductHandler),
  ];
}

