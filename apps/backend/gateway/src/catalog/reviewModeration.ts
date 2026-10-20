import { createLogger } from "@delegolabs/utils";
import {
  ReviewModerationAuditLog,
  ReviewAppeal,
  type ReviewModerationVerdict,
} from "../models/index.js";

const log = createLogger("gateway:review-moderation", process.env.LOG_LEVEL ?? "info");

export const REVIEW_MODERATION_ROLES = ["admin", "moderator"] as const;

/** True when the resolved auth roles include an admin or moderator role. */
export function hasReviewModerationRole(roles: readonly string[] | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  return roles.some((role) => (REVIEW_MODERATION_ROLES as readonly string[]).includes(role));
}

export interface MerchantReviewNotification {
  merchantId: string;
  appealId: string;
  reviewId: string;
  verdict: ReviewModerationVerdict;
  reviewVisible: boolean;
  message: string;
}

const NOTIFICATION_CHANNEL = "merchant:review-appeal:resolved";

/** Minimal pub/sub surface needed to notify the notifications service. */
export interface ReviewNotificationRedis {
  publish(channel: string, message: string): Promise<unknown>;
}

/**
 * Publish a merchant notification for a resolved appeal.
 *
 * Notifications are emitted on a Redis pub/sub channel so the notifications
 * service can fan out to the merchant's preferred channels. When no Redis
 * client is configured (e.g. unit tests / local dev) the event is only logged,
 * which keeps resolution side-effect free but observable.
 */
export async function notifyMerchantOfVerdict(
  notification: MerchantReviewNotification,
  redis?: ReviewNotificationRedis,
): Promise<void> {
  log.info("Merchant review appeal resolved", { ...notification });

  if (!redis) return;
  try {
    await redis.publish(NOTIFICATION_CHANNEL, JSON.stringify(notification));
  } catch (err) {
    // A notification failure must never fail the moderation decision.
    log.error("Failed to publish merchant review notification", {
      appealId: notification.appealId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface RecordVerdictInput {
  appealId: string;
  reviewId: string;
  operatorId: string;
  verdict: ReviewModerationVerdict;
  notes: string;
  decidedAt?: Date;
}

/**
 * Persist an immutable audit record for an administrative verdict.
 *
 * Returns the created record; callers may persist a fallback in-memory entry
 * when the database is unavailable (see `recordVerdict` in reviews.ts).
 */
export async function recordModerationVerdict(
  input: RecordVerdictInput,
): Promise<ReviewModerationAuditLog> {
  return ReviewModerationAuditLog.create({
    appealId: input.appealId,
    reviewId: input.reviewId,
    operatorId: input.operatorId,
    verdict: input.verdict,
    notes: input.notes,
    decidedAt: input.decidedAt ?? new Date(),
  });
}

/**
 * Apply an administrative verdict to an appeal:
 *   1. transition the appeal state,
 *   2. update review visibility,
 *   3. write the audit record,
 *   4. notify the merchant.
 *
 * Returns the updated appeal.
 */
export async function applyVerdict(
  appeal: ReviewAppeal,
  verdict: ReviewModerationVerdict,
  operatorId: string,
  notes: string,
  redis?: ReviewNotificationRedis,
): Promise<ReviewAppeal> {
  const status = verdict === "remove_review" ? "approved" : "rejected";

  await appeal.update({
    status,
    moderatorNotes: notes,
    moderatorId: operatorId,
    resolvedAt: new Date(),
  });

  let reviewVisible = true;
  if (appeal.review) {
    reviewVisible = verdict !== "remove_review";
    await appeal.review.update({ isVisible: reviewVisible });
  }

  await recordModerationVerdict({
    appealId: appeal.id,
    reviewId: appeal.reviewId,
    operatorId,
    verdict,
    notes,
  });

  await notifyMerchantOfVerdict(
    {
      merchantId: appeal.merchantId,
      appealId: appeal.id,
      reviewId: appeal.reviewId,
      verdict,
      reviewVisible,
      message:
        verdict === "remove_review"
          ? "Your review appeal was approved and the review has been removed."
          : verdict === "warn_buyer"
            ? "Your review appeal was reviewed; the buyer has been warned."
            : "Your review appeal was reviewed and the review was kept.",
    },
    redis,
  );

  return appeal;
}
