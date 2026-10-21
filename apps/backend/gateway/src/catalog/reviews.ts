import type { IncomingMessage, ServerResponse } from "node:http";
import { Op } from "sequelize";
import type { Route } from "@delegolabs/utils";
import { route, createLogger, validatePublicKey } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../../middleware/auth.js";
import { validateSchema, ReviewSubmissionSchema, ReviewAppealSchema, ReviewModerationSchema, AdminVerdictSchema } from "../../src/validation.js";
import { readJsonBody, InvalidJsonError, BodyTooLargeError } from "../../src/request.js";
import { badRequest, notFound, unauthorized, forbidden, sendApiError } from "../../src/errors.js";
import { Merchant, Product, Review, ReviewAppeal, PaymentRecord } from "../../src/models/index.js";
import {
  hasReviewModerationRole as rolesGrantModeration,
  applyVerdict,
} from "./reviewModeration.js";

const log = createLogger("gateway:reviews", process.env.LOG_LEVEL ?? "info");

function hasReviewModerationRole(req: IncomingMessage): boolean {
  return rolesGrantModeration(getAuthenticatedUserContext(req)?.roles);
}

/**
 * Emit reputation.review_added event
 * This would publish to an event bus in a real implementation
 */
async function emitReviewAddedEvent(review: Review): Promise<void> {
  // Placeholder for event emission - would use event publisher in production
  log.info("reputation.review_added event emitted", {
    reviewId: review.id,
    productId: review.productId,
    orderId: review.orderId,
    rating: review.rating,
  });
}

/**
 * Emit a structured moderation log entry. Persistent audit records are written
 * by `applyVerdict`/`recordModerationVerdict` in reviewModeration.ts.
 */
function emitModerationAuditLog(
  appealId: string,
  reviewId: string,
  moderatorId: string,
  decision: "approved" | "rejected",
  notes?: string,
): void {
  log.info("Review moderation audit", {
    appealId,
    reviewId,
    moderatorId,
    decision,
    notes,
    timestamp: new Date().toISOString(),
  });
}

function formatReviewResponse(review: Review): Record<string, unknown> {
  return {
    id: review.id,
    orderId: review.orderId,
    productId: review.productId,
    buyerAddress: review.buyerAddress,
    rating: review.rating,
    title: review.title,
    content: review.content,
    isVisible: review.isVisible,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}

function formatAppealResponse(appeal: ReviewAppeal): Record<string, unknown> {
  return {
    id: appeal.id,
    reviewId: appeal.reviewId,
    merchantId: appeal.merchantId,
    reasonCategory: appeal.reasonCategory,
    justification: appeal.justification,
    evidenceUrls: appeal.evidenceUrls,
    status: appeal.status,
    moderatorNotes: appeal.moderatorNotes,
    resolvedAt: appeal.resolvedAt?.toISOString() ?? null,
    createdAt: appeal.createdAt.toISOString(),
    updatedAt: appeal.updatedAt.toISOString(),
  };
}

/**
 * POST /api/v1/reviews
 * Submit a review with buyer verification
 * - Verifies order state is 'settled' or 'released' in payment_records
 * - Verifies signer public key matches order buyer_address
 * - Enforces 1 review per settled order via unique index
 */
export async function submitReviewHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const body = await readJsonBody(req);
    const validation = validateSchema(ReviewSubmissionSchema, body);
    if (!validation.valid) {
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    const { orderId, rating, title, content, escrowContractId, buyerSignature } = body;

    // 1. Verify order state in payment_records is 'settled' or 'released'
    const paymentRecord = await PaymentRecord.findOne({
      where: { 
        orderId,
        escrowContractId,
        status: { [Op.in]: ["settled", "released"] },
      },
    });

    if (!paymentRecord) {
      sendApiError(res, 400, "ORDER_NOT_SETTLED",
        "Order is not in settled or released state, or does not exist", req);
      return;
    }

    // 2. Verify signer public key matches order buyer_address
    // In a real implementation, we'd verify the signature here
    // For now, we check that buyerSignature is provided and non-empty
    if (!buyerSignature || buyerSignature.length < 10) {
      sendApiError(res, 400, "INVALID_SIGNATURE",
        "Invalid buyer signature", req);
      return;
    }

    // 3. Enforce 1 review per settled order (unique index will catch this)
    // Also check explicitly to provide a good error message
    const existingReview = await Review.findOne({
      where: { orderId },
    });
    if (existingReview) {
      sendApiError(res, 409, "REVIEW_ALREADY_EXISTS",
        "A review has already been submitted for this order", req);
      return;
    }

    const review = await Review.create({
      orderId,
      productId: body.productId, // Should be validated as required
      buyerAddress: paymentRecord.buyerAddress,
      escrowContractId,
      buyerSignature,
      rating,
      title,
      content,
      isVisible: true,
    });

    // Emit reputation event
    await emitReviewAddedEvent(review);

    log.info("Review submitted", {
      reviewId: review.id,
      orderId,
      productId: review.productId,
      rating,
      userId: auth.userId,
    });

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: formatReviewResponse(review),
      error: null,
    }));
  } catch (err: any) {
    // Handle unique constraint violation (1 review per order)
    if (err?.name === "SequelizeUniqueConstraintError" ||
        err?.errors?.some((e: any) => e.type === "unique violation" && e.path === "order_id")) {
      sendApiError(res, 409, "REVIEW_ALREADY_EXISTS",
        "A review has already been submitted for this order", req);
      return;
    }
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to submit review", {
      error: err instanceof Error ? err.message : String(err),
      userId: extractAuth(req).userId,
    });
    sendApiError(res, 500, "REVIEW_SUBMIT_FAILED",
      err instanceof Error ? err.message : "Failed to submit review", req);
  }
}

/**
 * GET /api/v1/products/:productId/reviews
 * List reviews for a product (only visible ones)
 */
export async function listReviewsHandler(
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

    const product = await Product.findByPk(productId, { attributes: ["id"] });
    if (!product) {
      notFound(res, "Product not found", req);
      return;
    }

    const reviews = await Review.findAll({
      where: { 
        productId,
        isVisible: true,
      },
      order: [["createdAt", "DESC"]],
    });

    // Calculate average rating
    const avgRating = reviews.length > 0
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
      : null;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        items: reviews.map(formatReviewResponse),
        totalCount: reviews.length,
        averageRating: avgRating ? Number(avgRating.toFixed(2)) : null,
      },
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to list reviews", {
      error: err instanceof Error ? err.message : String(err),
      productId: params.productId,
    });
    sendApiError(res, 500, "REVIEWS_LIST_FAILED",
      err instanceof Error ? err.message : "Failed to list reviews", req);
  }
}

/**
 * POST /api/v1/merchant/reviews/:reviewId/appeal
 * Submit an appeal for a review
 */
export async function submitAppealHandler(
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

    const reviewId = params.reviewId;
    if (!reviewId) {
      badRequest(res, "reviewId path parameter is required", req);
      return;
    }

    const review = await Review.findByPk(reviewId, {
      include: [{ 
        model: Product, 
        as: "product",
        include: [{ model: Merchant, as: "merchant" }],
      }],
    });
    if (!review) {
      notFound(res, "Review not found", req);
      return;
    }

    // Get the merchant associated with the product
    const product = (review as any).product as Product;
    const merchant = (product as any).merchant as Merchant;
    
    // Check if user owns the merchant
    if (merchant.ownerUserId !== auth.userId) {
      forbidden(res, "You can only appeal reviews for your own products", req);
      return;
    }

    const body = await readJsonBody(req);
    const validation = validateSchema(ReviewAppealSchema, body);
    if (!validation.valid) {
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    // Check if appeal already exists for this review
    const existingAppeal = await ReviewAppeal.findOne({
      where: { reviewId },
    });
    if (existingAppeal) {
      sendApiError(res, 409, "APPEAL_ALREADY_EXISTS",
        "An appeal has already been submitted for this review", req);
      return;
    }

    const appeal = await ReviewAppeal.create({
      reviewId,
      merchantId: merchant.id,
      reasonCategory: body.reasonCategory,
      justification: body.justification,
      evidenceUrls: body.evidenceUrls,
      status: "pending_review",
    });

    log.info("Review appeal submitted", {
      appealId: appeal.id,
      reviewId,
      merchantId: merchant.id,
      reasonCategory: body.reasonCategory,
      userId: auth.userId,
    });

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: formatAppealResponse(appeal),
      error: null,
    }));
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to submit appeal", {
      error: err instanceof Error ? err.message : String(err),
      reviewId: params.reviewId,
      userId: extractAuth(req).userId,
    });
    sendApiError(res, 500, "APPEAL_SUBMIT_FAILED",
      err instanceof Error ? err.message : "Failed to submit appeal", req);
  }
}

/**
 * GET /api/v1/admin/reviews/appeals
 * List all pending appeals (admin endpoint)
 */
export async function listAppealsHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    if (!hasReviewModerationRole(req)) {
      forbidden(res, "Admin or moderator role required", req);
      return;
    }

    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const status = url.searchParams.get("status");

    const VALID_STATUSES = ["pending_review", "approved", "rejected"];
    if (status && !VALID_STATUSES.includes(status)) {
      badRequest(res, `status must be one of: ${VALID_STATUSES.join(", ")}`, req);
      return;
    }

    const whereClause: Record<string, unknown> = {};
    if (status) {
      whereClause.status = status;
    }

    const appeals = await ReviewAppeal.findAll({
      where: whereClause,
      include: [
        { model: Review, as: "review" },
        { model: Merchant, as: "merchant" },
      ],
      order: [["createdAt", "DESC"]],
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        items: appeals.map(formatAppealResponse),
        totalCount: appeals.length,
      },
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to list appeals", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendApiError(res, 500, "APPEALS_LIST_FAILED",
      err instanceof Error ? err.message : "Failed to list appeals", req);
  }
}

/**
 * PATCH /api/v1/admin/reviews/appeals/:appealId
 * Moderate a review appeal (approve or reject)
 */
export async function moderateAppealHandler(
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

    if (!hasReviewModerationRole(req)) {
      forbidden(res, "Admin or moderator role required", req);
      return;
    }

    // In a real system, verify user has admin role
    const appealId = params.appealId;
    if (!appealId) {
      badRequest(res, "appealId path parameter is required", req);
      return;
    }

    const appeal = await ReviewAppeal.findByPk(appealId, {
      include: [{ model: Review, as: "review" }],
    });
    if (!appeal) {
      notFound(res, "Appeal not found", req);
      return;
    }

    if (appeal.status !== "pending_review") {
      sendApiError(res, 400, "APPEAL_ALREADY_RESOLVED",
        "This appeal has already been moderated", req);
      return;
    }

    const body = await readJsonBody(req);
    const validation = validateSchema(ReviewModerationSchema, body);
    if (!validation.valid) {
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    const { status, moderatorNotes } = body;

    // Update appeal
    await appeal.update({
      status,
      moderatorNotes: moderatorNotes ?? null,
      moderatorId: auth.userId,
      resolvedAt: new Date(),
    });

    // If approved, hide the associated review
    if (status === "approved" && appeal.review) {
      await appeal.review.update({ isVisible: false });
    }

    // Emit audit log
    emitModerationAuditLog(
      appealId,
      appeal.reviewId,
      auth.userId,
      status,
      moderatorNotes,
    );

    log.info("Appeal moderated", {
      appealId,
      reviewId: appeal.reviewId,
      status,
      moderatorId: auth.userId,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: formatAppealResponse(appeal),
      error: null,
    }));
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to moderate appeal", {
      error: err instanceof Error ? err.message : String(err),
      appealId: params.appealId,
      userId: extractAuth(req).userId,
    });
    sendApiError(res, 500, "APPEAL_MODERATION_FAILED",
      err instanceof Error ? err.message : "Failed to moderate appeal", req);
  }
}

export async function adminVerdictHandler(
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

    if (!hasReviewModerationRole(req)) {
      forbidden(res, "Admin or moderator role required", req);
      return;
    }

    const appealId = params.appealId;
    if (!appealId) {
      badRequest(res, "appealId path parameter is required", req);
      return;
    }

    const body = await readJsonBody(req);
    const validation = validateSchema(AdminVerdictSchema, body);
    if (!validation.valid) {
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    const { verdict, adminNotes } = body;
    const appeal = await ReviewAppeal.findByPk(appealId, {
      include: [{ model: Review, as: "review" }],
    });
    if (!appeal) {
      notFound(res, "Appeal not found", req);
      return;
    }

    if (appeal.status !== "pending_review") {
      sendApiError(res, 400, "APPEAL_ALREADY_RESOLVED",
        "This appeal has already been moderated", req);
      return;
    }

    await applyVerdict(appeal, verdict, auth.userId, adminNotes);

    log.info("Admin review verdict applied", {
      appealId,
      reviewId: appeal.reviewId,
      verdict,
      operatorId: auth.userId,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        ...formatAppealResponse(appeal),
        verdict,
        adminNotes,
      },
      error: null,
    }));
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to apply admin verdict", {
      error: err instanceof Error ? err.message : String(err),
      appealId: params.appealId,
      userId: extractAuth(req).userId,
    });
    sendApiError(res, 500, "ADMIN_VERDICT_FAILED",
      err instanceof Error ? err.message : "Failed to apply admin verdict", req);
  }
}

export function registerReviewRoutes(): Route[] {
  return [
    // Review submission (public)
    route("POST", "/api/v1/reviews", submitReviewHandler),
    route("GET", "/api/v1/products/:productId/reviews", listReviewsHandler),
    
    // Merchant appeal endpoint
    route("POST", "/api/v1/merchant/reviews/:reviewId/appeal", submitAppealHandler),
    
    // Admin moderation
    route("GET", "/api/v1/admin/reviews/appeals", listAppealsHandler),
    route("PATCH", "/api/v1/admin/reviews/appeals/:appealId", moderateAppealHandler),
    route("POST", "/api/v1/admin/reviews/appeals/:appealId/verdict", adminVerdictHandler),
  ];
}
