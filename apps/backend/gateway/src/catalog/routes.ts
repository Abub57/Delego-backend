import type { IncomingMessage, ServerResponse } from "node:http";
import { Op } from "sequelize";
import type { Route } from "@delegolabs/utils";
import { route, createLogger } from "@delegolabs/utils";
import { extractAuth } from "../../middleware/auth.js";
import { validateSchema, CreateProductSchema, UpdateProductSchema } from "../../src/validation.js";
import { parsePaginationQuery } from "../../src/pagination.js";
import { encodeCursor, decodeCursor } from "../../src/base64Cursor.js";
import { readJsonBody, InvalidJsonError, BodyTooLargeError } from "../../src/request.js";
import { badRequest, notFound, unauthorized, forbidden, sendApiError } from "../../src/errors.js";
import { Merchant, Product } from "../../src/models/index.js";

const log = createLogger("gateway:catalog", process.env.LOG_LEVEL ?? "info");

function formatProductResponse(product: Product): Record<string, unknown> {
  return {
    id: product.id,
    merchantId: product.merchantId,
    sku: product.sku,
    title: product.title,
    description: product.description,
    priceStroops: String(product.priceStroops),
    assetCode: product.assetCode,
    stockQuantity: product.stockQuantity,
    isListed: product.isListed,
    imageUrl: product.imageUrl,
    metadata: product.metadata,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

async function requireMerchantOwnership(
  userId: string,
  merchantId: string,
): Promise<Merchant | null> {
  const merchant = await Merchant.findOne({
    where: { id: merchantId, ownerUserId: userId },
  });
  return merchant;
}

async function requireProductOwnership(
  userId: string,
  productId: string,
): Promise<{ product: Product; merchant: Merchant } | null> {
  const product = await Product.findByPk(productId, {
    include: [{ model: Merchant, as: "merchant" }],
  });
  if (!product) return null;
  const merchant = (product as any).merchant as Merchant;
  if (merchant.ownerUserId !== userId) return null;
  return { product, merchant };
}

export async function createProductHandler(
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

    const merchantId = params.merchantId;
    if (!merchantId) {
      badRequest(res, "merchantId path parameter is required", req);
      return;
    }

    const merchant = await requireMerchantOwnership(auth.userId, merchantId);
    if (!merchant) {
      forbidden(res, "You do not own this merchant store", req);
      return;
    }

    const body = await readJsonBody(req);
    const validation = validateSchema(CreateProductSchema, body);
    if (!validation.valid) {
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    try {
      const product = await Product.create({
        merchantId,
        sku: body.sku,
        title: body.title,
        description: body.description ?? null,
        priceStroops: BigInt(body.priceStroops),
        assetCode: body.assetCode ?? "USDC",
        stockQuantity: body.stockQuantity ?? 0,
        isListed: body.isListed ?? true,
        imageUrl: body.imageUrl ?? null,
        metadata: body.metadata ?? {},
      });

      log.info("Product created", { productId: product.id, merchantId, userId: auth.userId });

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: formatProductResponse(product),
        error: null,
      }));
    } catch (createErr: any) {
      if (createErr?.name === "SequelizeUniqueConstraintError" ||
          createErr?.errors?.some((e: any) => e.type === "unique violation")) {
        sendApiError(res, 409, "DUPLICATE_SKU",
          "A product with this SKU already exists for this merchant", req);
        return;
      }
      throw createErr;
    }
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to create product", {
      error: err instanceof Error ? err.message : String(err),
      userId: extractAuth(req).userId,
    });
    sendApiError(res, 500, "PRODUCT_CREATE_FAILED",
      err instanceof Error ? err.message : "Failed to create product", req);
  }
}

export async function getProductHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const productId = params.productId;
    if (!productId) {
      badRequest(res, "productId path parameter is required", req);
      return;
    }

    const product = await Product.findByPk(productId);
    if (!product) {
      notFound(res, "Product not found", req);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: formatProductResponse(product),
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to fetch product", {
      error: err instanceof Error ? err.message : String(err),
      productId: params.productId,
    });
    sendApiError(res, 500, "PRODUCT_FETCH_FAILED",
      err instanceof Error ? err.message : "Failed to fetch product", req);
  }
}

export async function listProductsHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const merchantId = params.merchantId;
    if (!merchantId) {
      badRequest(res, "merchantId path parameter is required", req);
      return;
    }

    const merchantExists = await Merchant.findByPk(merchantId, { attributes: ["id"] });
    if (!merchantExists) {
      notFound(res, "Merchant not found", req);
      return;
    }

    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const paginationResult = parsePaginationQuery(url.searchParams);
    if (!paginationResult.ok) {
      badRequest(res, paginationResult.error.message, req, paginationResult.error);
      return;
    }
    const { limit, cursor, sort } = paginationResult.value;

    const whereClause: Record<string, unknown> = {
      merchantId,
      isListed: true,
    };

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        badRequest(res, "Invalid cursor format", req);
        return;
      }
      const sortDirection = sort === "asc" ? Op.gt : Op.lt;
      whereClause[Op.and] = [
        {
          [Op.or]: [
            { createdAt: { [sortDirection]: new Date(decoded.createdAt) } },
            {
              createdAt: new Date(decoded.createdAt),
              id: { [sortDirection]: decoded.id },
            },
          ],
        },
      ];
    }

    const order = sort === "asc"
      ? [["createdAt", "ASC"], ["id", "ASC"]]
      : [["createdAt", "DESC"], ["id", "DESC"]];

    const products = await Product.findAll({
      where: whereClause,
      order,
      limit: limit + 1,
    });

    const hasMore = products.length > limit;
    const pageItems = hasMore ? products.slice(0, limit) : products;
    const nextCursor: string | null = hasMore && pageItems.length > 0
      ? encodeCursor(pageItems[pageItems.length - 1].createdAt.toISOString(), pageItems[pageItems.length - 1].id)
      : null;

    const totalCount = await Product.count({
      where: { merchantId, isListed: true },
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        items: pageItems.map(formatProductResponse),
        nextCursor,
        totalCount,
      },
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to list products", {
      error: err instanceof Error ? err.message : String(err),
      merchantId: params.merchantId,
    });
    sendApiError(res, 500, "PRODUCTS_LIST_FAILED",
      err instanceof Error ? err.message : "Failed to list products", req);
  }
}

export async function updateProductHandler(
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

    const productId = params.productId;
    if (!productId) {
      badRequest(res, "productId path parameter is required", req);
      return;
    }

    const ownership = await requireProductOwnership(auth.userId, productId);
    if (!ownership) {
      const exists = await Product.findByPk(productId, { attributes: ["id"] });
      if (!exists) {
        notFound(res, "Product not found", req);
        return;
      }
      forbidden(res, "You do not own this product", req);
      return;
    }

    const body = await readJsonBody(req);
    const validation = validateSchema(UpdateProductSchema, body);
    if (!validation.valid) {
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    const { product } = ownership;
    const updateFields: Partial<Product> = {};
    if (body.sku !== undefined) updateFields.sku = body.sku;
    if (body.title !== undefined) updateFields.title = body.title;
    if (body.description !== undefined) updateFields.description = body.description;
    if (body.priceStroops !== undefined) updateFields.priceStroops = BigInt(body.priceStroops);
    if (body.assetCode !== undefined) updateFields.assetCode = body.assetCode;
    if (body.stockQuantity !== undefined) updateFields.stockQuantity = body.stockQuantity;
    if (body.isListed !== undefined) updateFields.isListed = body.isListed;
    if (body.imageUrl !== undefined) updateFields.imageUrl = body.imageUrl;
    if (body.metadata !== undefined) updateFields.metadata = body.metadata;

    try {
      await product.update(updateFields);
      await product.reload();
    } catch (updateErr: any) {
      if (updateErr?.name === "SequelizeUniqueConstraintError" ||
          updateErr?.errors?.some((e: any) => e.type === "unique violation")) {
        sendApiError(res, 409, "DUPLICATE_SKU",
          "A product with this SKU already exists for this merchant", req);
        return;
      }
      throw updateErr;
    }

    log.info("Product updated", { productId, userId: auth.userId });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: formatProductResponse(product),
      error: null,
    }));
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to update product", {
      error: err instanceof Error ? err.message : String(err),
      productId: params.productId,
      userId: extractAuth(req).userId,
    });
    sendApiError(res, 500, "PRODUCT_UPDATE_FAILED",
      err instanceof Error ? err.message : "Failed to update product", req);
  }
}

export async function deleteProductHandler(
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

    const productId = params.productId;
    if (!productId) {
      badRequest(res, "productId path parameter is required", req);
      return;
    }

    const ownership = await requireProductOwnership(auth.userId, productId);
    if (!ownership) {
      const exists = await Product.findByPk(productId, { attributes: ["id"] });
      if (!exists) {
        notFound(res, "Product not found", req);
        return;
      }
      forbidden(res, "You do not own this product", req);
      return;
    }

    await ownership.product.destroy();
    log.info("Product deleted", { productId, userId: auth.userId });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: { deleted: true, id: productId },
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to delete product", {
      error: err instanceof Error ? err.message : String(err),
      productId: params.productId,
      userId: extractAuth(req).userId,
    });
    sendApiError(res, 500, "PRODUCT_DELETE_FAILED",
      err instanceof Error ? err.message : "Failed to delete product", req);
  }
}

export function registerCatalogRoutes(): Route[] {
  return [
    route("POST", "/api/v1/merchants/:merchantId/products", createProductHandler),
    route("GET", "/api/v1/merchants/:merchantId/products", listProductsHandler),
    route("GET", "/api/v1/products/:productId", getProductHandler),
    route("PUT", "/api/v1/products/:productId", updateProductHandler),
    route("DELETE", "/api/v1/products/:productId", deleteProductHandler),
  ];
}
