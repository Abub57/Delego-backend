import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  hasReviewModerationRole,
  applyVerdict,
  notifyMerchantOfVerdict,
  recordModerationVerdict,
} from "./reviewModeration.js";

vi.mock("../models/index.js", () => {
  return {
    ReviewModerationAuditLog: {
      create: vi.fn(async (input: Record<string, unknown>) => ({ id: "audit-1", ...input })),
    },
    ReviewAppeal: class {},
  };
});

import { ReviewModerationAuditLog } from "../models/index.js";

function buildAppeal(overrides: Record<string, unknown> = {}) {
  const review = {
    isVisible: true,
    update: vi.fn(function update(this: { isVisible: boolean }, patch: { isVisible: boolean }) {
      this.isVisible = patch.isVisible;
      return Promise.resolve(this);
    }),
  };
  const appeal = {
    id: "appeal-1",
    reviewId: "review-1",
    merchantId: "merchant-1",
    status: "pending_review",
    review,
    update: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(appeal, patch);
      return appeal;
    }),
    ...overrides,
  };
  return { appeal, review };
}

describe("#520 review moderation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("hasReviewModerationRole", () => {
    it("accepts admin and moderator roles", () => {
      expect(hasReviewModerationRole(["admin"])).toBe(true);
      expect(hasReviewModerationRole(["moderator"])).toBe(true);
      expect(hasReviewModerationRole(["buyer", "admin"])).toBe(true);
    });

    it("rejects missing or unrelated roles", () => {
      expect(hasReviewModerationRole(undefined)).toBe(false);
      expect(hasReviewModerationRole([])).toBe(false);
      expect(hasReviewModerationRole(["buyer", "merchant"])).toBe(false);
    });
  });

  describe("applyVerdict", () => {
    it("removes the review and records the operator, notes and timestamp for remove_review", async () => {
      const { appeal, review } = buildAppeal();

      await applyVerdict(appeal as never, "remove_review", "admin-7", "clear fraud");

      expect(appeal.status).toBe("approved");
      expect(appeal.moderatorId).toBe("admin-7");
      expect(appeal.moderatorNotes).toBe("clear fraud");
      expect(appeal.resolvedAt).toBeInstanceOf(Date);
      expect(review.isVisible).toBe(false);

      expect(ReviewModerationAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          appealId: "appeal-1",
          reviewId: "review-1",
          operatorId: "admin-7",
          verdict: "remove_review",
          notes: "clear fraud",
        }),
      );
    });

    it("keeps the review visible for keep_review", async () => {
      const { appeal, review } = buildAppeal();

      await applyVerdict(appeal as never, "keep_review", "moderator-1", "review stands");

      expect(appeal.status).toBe("rejected");
      expect(review.isVisible).toBe(true);
    });

    it("keeps the review visible but records a warn_buyer verdict", async () => {
      const { appeal, review } = buildAppeal();

      await applyVerdict(appeal as never, "warn_buyer", "admin-2", "warned buyer");

      expect(review.isVisible).toBe(true);
      expect(ReviewModerationAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ verdict: "warn_buyer" }),
      );
    });
  });

  describe("recordModerationVerdict", () => {
    it("records timestamp, operator id and notes in the audit log", async () => {
      const decidedAt = new Date("2026-10-20T00:00:00Z");
      await recordModerationVerdict({
        appealId: "appeal-9",
        reviewId: "review-9",
        operatorId: "admin-9",
        verdict: "keep_review",
        notes: "no violation",
        decidedAt,
      });

      expect(ReviewModerationAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          operatorId: "admin-9",
          notes: "no violation",
          decidedAt,
          verdict: "keep_review",
        }),
      );
    });
  });

  describe("notifyMerchantOfVerdict", () => {
    it("publishes a merchant notification when redis is configured", async () => {
      const publish = vi.fn(async () => 1);
      const redis = { publish } as unknown as Parameters<typeof notifyMerchantOfVerdict>[1];

      await notifyMerchantOfVerdict(
        {
          merchantId: "merchant-1",
          appealId: "appeal-1",
          reviewId: "review-1",
          verdict: "remove_review",
          reviewVisible: false,
          message: "removed",
        },
        redis,
      );

      expect(publish).toHaveBeenCalledTimes(1);
      const [channel, payload] = publish.mock.calls[0] as unknown as [string, string];
      expect(channel).toBe("merchant:review-appeal:resolved");
      expect(JSON.parse(payload)).toMatchObject({ merchantId: "merchant-1", verdict: "remove_review" });
    });

    it("never throws when redis publish fails", async () => {
      const publish = vi.fn(async () => {
        throw new Error("redis down");
      });
      const redis = { publish } as unknown as Parameters<typeof notifyMerchantOfVerdict>[1];

      await expect(
        notifyMerchantOfVerdict(
          {
            merchantId: "merchant-1",
            appealId: "appeal-1",
            reviewId: "review-1",
            verdict: "keep_review",
            reviewVisible: true,
            message: "kept",
          },
          redis,
        ),
      ).resolves.toBeUndefined();
    });
  });
});
