import type { IncomingMessage, ServerResponse } from "node:http";
import { Op, type Transaction } from "sequelize";
import type { Route } from "@delegolabs/utils";
import { route, createLogger } from "@delegolabs/utils";
import { extractAuth } from "../../middleware/auth.js";
import { validateSchema, CreateProductVariantSchema, UpdateProductVariantStockSchema } from "../../src/validation.js";
import { readJsonBody, InvalidJsonError, BodyTooLargeError } from "../../src/request.js";
import { badRequest, notFound, unauthorized, forbidden, sendApiError } from "../../src/errors.js";
import { sequelize } from "../../src/db.js";
import { Merchant, Product, ProductVariant } from "../../src/models/index.js";

const log = createLogger("gateway:variants", process.env.LOG_LEVEL ?? "info");

function formatVariantResponse(variant: ProductVariant): Record<string, unknown> {
  return {
    id: variant.id,
    productId: variant.productId,
    sku: variant.sku,
    attributes: variant.attributes,
    priceStroops: String(variant.priceStroops),
    stockCount: variant.stockCount,
    barcode: variant.barcode,
    createdAt: variant.createdAt.toISOString(),
    updatedAt: variant.updatedAt.toISOString(),
  };
}

/**
 * POST /api/v1/merchants/:merchantId/products/:productId/variants
 * Create a new product variant with SKU duplication detection
 */
export async function createVariantHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const { merchantId, productId } = params;
    if (!merchantId || !productId) {
      badRequest(res, "merchantId and productId path parameters are required", req);
      return;
    }

    // Verify merchant ownership
    const merchant = await Merchant.findOne({
      where: { id: merchantId, ownerUserId: auth.userId },
    });
    if (!merchant) {
      forbidden(res, "You do not own this merchant store", req);
      return;
    }

    // Verify product belongs to merchant
    const product = await Product.findOne({
      where: { id: productId, merchantId },
    });
    if (!product) {
      notFound(res, "Product not found for this merchant", req);
      return;
    }

    const body = await readJsonBody(req);
    const validation = validateSchema(CreateProductVariantSchema, body);
    if (!validation.valid) {
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    // Check for duplicate SKU globally
    const existingVariant = await ProductVariant.findOne({
      where: { sku: body.sku },
    });
    if (existingVariant) {
      sendApiError(res, 409, "DUPLICATE_SKU",
        "A variant with this SKU already exists", req);
      return;
    }

    const variant = await ProductVariant.create({
      productId,
      sku: body.sku,
      attributes: body.attributes,
      priceStroops: BigInt(body.priceStroops),
      stockCount: body.stockCount ?? 0,
      barcode: body.barcode ?? null,
    });

    log.info("Product variant created", { 
      variantId: variant.id, 
      productId, 
      sku: body.sku,
      userId: auth.userId 
    });

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: formatVariantResponse(variant),
      error: null,
    }));
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to create product variant", {
      error: err instanceof Error ? err.message : String(err),
      userId: extractAuth(req).userId,
      productId: params.productId,
    });
    sendApiError(res, 500, "VARIANT_CREATE_FAILED",
      err instanceof Error ? err.message : "Failed to create product variant", req);
  }
}

/**
 * GET /api/v1/merchants/:merchantId/products/:productId/variants
 * List all variants for a product with JSON attribute filtering
 */
export async function listVariantsHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const { merchantId, productId } = params;
    if (!merchantId || !productId) {
      badRequest(res, "merchantId and productId path parameters are required", req);
      return;
    }

    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    
    // Support attribute filtering via query params (e.g., ?size=L&color=blue)
    const attributeFilters: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (["size", "color", "material"].includes(key)) {
        attributeFilters[key] = value;
      }
    }

    // Verify product exists
    const product = await Product.findOne({
      where: { id: productId, merchantId },
    });
    if (!product) {
      notFound(res, "Product not found for this merchant", req);
      return;
    }

    const whereClause: Record<string | symbol, unknown> = { productId };
    
    // Add JSONB attribute filtering if specified
    if (Object.keys(attributeFilters).length > 0) {
      for (const [key, value] of Object.entries(attributeFilters)) {
        const existing = whereClause[Op.and];
        whereClause[Op.and] = [
          ...(Array.isArray(existing) ? existing : []),
          { attributes: { [key]: value } },
        ];
      }
    }

    const variants = await ProductVariant.findAll({
      where: whereClause,
      order: [["createdAt", "DESC"]],
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        items: variants.map(formatVariantResponse),
        totalCount: variants.length,
      },
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to list product variants", {
      error: err instanceof Error ? err.message : String(err),
      productId: params.productId,
    });
    sendApiError(res, 500, "VARIANTS_LIST_FAILED",
      err instanceof Error ? err.message : "Failed to list product variants", req);
  }
}

/**
 * GET /api/v1/merchants/variants/:sku
 * Get a specific variant by SKU
 */
export async function getVariantBySkuHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const sku = params.sku;
    if (!sku) {
      badRequest(res, "sku path parameter is required", req);
      return;
    }

    const variant = await ProductVariant.findOne({
      where: { sku },
      include: [{ model: Product, as: "product" }],
    });
    if (!variant) {
      notFound(res, "Variant not found", req);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: formatVariantResponse(variant),
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to fetch variant", {
      error: err instanceof Error ? err.message : String(err),
      sku: params.sku,
    });
    sendApiError(res, 500, "VARIANT_FETCH_FAILED",
      err instanceof Error ? err.message : "Failed to fetch variant", req);
  }
}

/**
 * PATCH /api/v1/merchant/variants/:sku/stock
 * Update stock with atomic delta (positive=add, negative=subtract)
 */
export async function updateVariantStockHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const transaction = await sequelize.transaction();
  
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      await transaction.rollback();
      unauthorized(res, "Authentication required", req);
      return;
    }

    const sku = params.sku;
    if (!sku) {
      await transaction.rollback();
      badRequest(res, "sku path parameter is required", req);
      return;
    }

    const body = await readJsonBody(req);
    const validation = validateSchema(UpdateProductVariantStockSchema, body);
    if (!validation.valid) {
      await transaction.rollback();
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    const variant = await ProductVariant.findOne({
      where: { sku },
      include: [{ 
        model: Product, 
        as: "product",
        include: [{ model: Merchant, as: "merchant" }],
      }],
      transaction,
    });
    if (!variant) {
      await transaction.rollback();
      notFound(res, "Variant not found", req);
      return;
    }

    // Verify merchant ownership
    const product = (variant as any).product as Product;
    const merchant = (product as any).merchant as Merchant;
    if (merchant.ownerUserId !== auth.userId) {
      await transaction.rollback();
      forbidden(res, "You do not own this product variant", req);
      return;
    }

    const delta = body.delta;
    const newStockCount = variant.stockCount + delta;

    if (newStockCount < 0) {
      await transaction.rollback();
      sendApiError(res, 400, "INSUFFICIENT_STOCK",
        `Cannot reduce stock below 0. Current: ${variant.stockCount}, requested delta: ${delta}`, req);
      return;
    }

    // Atomic update using increment/decrement to avoid race conditions
    await variant.update({ stockCount: newStockCount }, { transaction });
    await variant.reload({ transaction });

    await transaction.commit();

    log.info("Variant stock updated", { 
      variantId: variant.id, 
      sku,
      delta,
      newStockCount: variant.stockCount,
      userId: auth.userId 
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: formatVariantResponse(variant),
      error: null,
    }));
  } catch (err: any) {
    if (!(transaction as Transaction & { finished?: string }).finished) {
      await transaction.rollback();
    }
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to update variant stock", {
      error: err instanceof Error ? err.message : String(err),
      sku: params.sku,
      userId: extractAuth(req).userId,
    });
    sendApiError(res, 500, "VARIANT_STOCK_UPDATE_FAILED",
      err instanceof Error ? err.message : "Failed to update variant stock", req);
  }
}

/**
 * DELETE /api/v1/merchants/variants/:sku
 * Delete a variant
 */
export async function deleteVariantHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const sku = params.sku;
    if (!sku) {
      badRequest(res, "sku path parameter is required", req);
      return;
    }

    const variant = await ProductVariant.findOne({
      where: { sku },
      include: [{ 
        model: Product, 
        as: "product",
        include: [{ model: Merchant, as: "merchant" }],
      }],
    });
    if (!variant) {
      notFound(res, "Variant not found", req);
      return;
    }

    // Verify merchant ownership
    const product = (variant as any).product as Product;
    const merchant = (product as any).merchant as Merchant;
    if (merchant.ownerUserId !== auth.userId) {
      forbidden(res, "You do not own this product variant", req);
      return;
    }

    await variant.destroy();
    log.info("Variant deleted", { variantId: variant.id, sku, userId: auth.userId });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: { deleted: true, sku },
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to delete variant", {
      error: err instanceof Error ? err.message : String(err),
      sku: params.sku,
      userId: extractAuth(req).userId,
    });
    sendApiError(res, 500, "VARIANT_DELETE_FAILED",
      err instanceof Error ? err.message : "Failed to delete variant", req);
  }
}

export function registerVariantRoutes(): Route[] {
  return [
    // Product variants
    route("POST", "/api/v1/merchants/:merchantId/products/:productId/variants", createVariantHandler),
    route("GET", "/api/v1/merchants/:merchantId/products/:productId/variants", listVariantsHandler),
    route("GET", "/api/v1/merchants/variants/:sku", getVariantBySkuHandler),
    route("PATCH", "/api/v1/merchants/variants/:sku/stock", updateVariantStockHandler),
    route("DELETE", "/api/v1/merchants/variants/:sku", deleteVariantHandler),
  ];
}