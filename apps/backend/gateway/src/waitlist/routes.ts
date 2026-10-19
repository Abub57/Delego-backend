/**
 * Product restock waitlist — POST /api/v1/products/:productId/waitlist
 *
 * Buyers subscribe to an out-of-stock product with an email address and/or
 * a Stellar wallet address (used to resolve web push subscriptions). When a
 * merchant raises stock above zero, the notifications service works through
 * the waitlist in signup order (see notifications/src/restock/worker.ts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "@delegolabs/utils";
import { route, createLogger, validatePublicKey } from "@delegolabs/utils";
import { sequelize } from "../db.js";
import { Product } from "../models/index.js";
import { readJsonBody, InvalidJsonError, BodyTooLargeError } from "../request.js";
import { badRequest, notFound, sendApiError } from "../errors.js";

const log = createLogger("gateway:waitlist", process.env.LOG_LEVEL ?? "info");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 255;

interface WaitlistRow {
  id: string;
  product_id: string;
  status: string;
  created_at: Date;
}

function formatSubscription(row: WaitlistRow, alreadySubscribed: boolean): Record<string, unknown> {
  return {
    id: row.id,
    productId: row.product_id,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    alreadySubscribed,
  };
}

export async function joinRestockWaitlistHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const productId = params.productId;
    if (!productId || !UUID_RE.test(productId)) {
      badRequest(res, "productId must be a valid UUID", req);
      return;
    }

    const body = await readJsonBody(req);
    const email =
      typeof body.email === "string" && body.email.trim() !== "" ? body.email.trim() : null;
    const buyerAddress =
      typeof body.buyerAddress === "string" && body.buyerAddress.trim() !== ""
        ? body.buyerAddress.trim()
        : null;

    if (!email && !buyerAddress) {
      badRequest(res, "Provide an email and/or buyerAddress to join the waitlist", req);
      return;
    }
    if (email && (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email))) {
      badRequest(res, "email must be a valid email address", req);
      return;
    }
    if (buyerAddress && !validatePublicKey(buyerAddress).valid) {
      badRequest(
        res,
        "buyerAddress must be a valid Stellar public key (56 characters starting with 'G')",
        req,
      );
      return;
    }

    const product = await Product.findByPk(productId, {
      attributes: ["id", "stockQuantity", "isListed"],
    });
    if (!product || !product.isListed) {
      notFound(res, "Product not found", req);
      return;
    }
    if (product.stockQuantity > 0) {
      sendApiError(res, 409, "PRODUCT_IN_STOCK", "This product is currently in stock", req);
      return;
    }

    // Partial unique indexes reject a second pending subscription for the
    // same contact; DO NOTHING turns that into an idempotent re-subscribe.
    const [inserted] = (await sequelize.query(
      `INSERT INTO product_restock_waitlist (product_id, buyer_address, email)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id, product_id, status, created_at`,
      { bind: [productId, buyerAddress, email] },
    )) as [WaitlistRow[], unknown];

    if (inserted.length > 0) {
      log.info("Buyer joined restock waitlist", { productId, waitlistId: inserted[0].id });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: formatSubscription(inserted[0], false), error: null }));
      return;
    }

    const [existing] = (await sequelize.query(
      `SELECT id, product_id, status, created_at
         FROM product_restock_waitlist
        WHERE product_id = $1
          AND status = 'pending'
          AND (LOWER(email) = LOWER($2) OR buyer_address = $3)
        ORDER BY created_at ASC
        LIMIT 1`,
      { bind: [productId, email, buyerAddress] },
    )) as [WaitlistRow[], unknown];

    if (existing.length === 0) {
      // Conflicting row was notified/cancelled between INSERT and SELECT.
      sendApiError(res, 409, "WAITLIST_CONFLICT", "Please retry the subscription", req);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: formatSubscription(existing[0], true), error: null }));
  } catch (err) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to join restock waitlist", {
      productId: params.productId,
      error: err instanceof Error ? err.message : String(err),
    });
    sendApiError(res, 500, "WAITLIST_JOIN_FAILED", "Failed to join the restock waitlist", req);
  }
}

export function registerWaitlistRoutes(): Route[] {
  return [route("POST", "/api/v1/products/:productId/waitlist", joinRestockWaitlistHandler)];
}
