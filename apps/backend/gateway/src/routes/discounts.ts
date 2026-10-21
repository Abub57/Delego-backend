import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Route } from "@delegolabs/utils";
import { route, createLogger } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../../middleware/auth.js";
import { readJsonBody, InvalidJsonError, BodyTooLargeError } from "../request.js";
import { badRequest, notFound, unauthorized, forbidden, sendApiError } from "../errors.js";
import { Merchant, Discount } from "../models/index.js";

const log = createLogger("gateway:discounts", process.env.LOG_LEVEL ?? "info");

export interface CreateDiscountDTO {
  code: string;
  discountType: "percentage" | "fixed_stroops";
  discountValue: string;
  minOrderStroops?: string;
  maxUses?: number;
  validFrom: string;
  validUntil: string;
}

export const CreateDiscountSchema: z.ZodType<CreateDiscountDTO> = z
  .object({
    code: z
      .string({ required_error: "Promo code is required" })
      .min(1, "Promo code cannot be empty")
      .regex(/^[A-Z0-9]+$/, "Promo code must contain only alphanumeric uppercase characters"),
    discountType: z.enum(["percentage", "fixed_stroops"], {
      required_error: "Discount type is required (percentage or fixed_stroops)",
    }),
    discountValue: z
      .string({ required_error: "Discount value is required" })
      .min(1, "Discount value is required")
      .refine((val) => {
        const num = Number(val);
        return !isNaN(num) && num > 0;
      }, "Discount value must be a positive number"),
    minOrderStroops: z
      .string()
      .regex(/^\d+$/, "minOrderStroops must be a non-negative integer string")
      .optional(),
    maxUses: z
      .number()
      .int("maxUses must be an integer")
      .positive("maxUses must be greater than zero")
      .optional(),
    validFrom: z
      .string({ required_error: "validFrom date is required" })
      .refine((val) => !isNaN(Date.parse(val)), "validFrom must be a valid ISO date string"),
    validUntil: z
      .string({ required_error: "validUntil date is required" })
      .refine((val) => !isNaN(Date.parse(val)), "validUntil must be a valid ISO date string"),
  })
  .refine(
    (data) => {
      if (data.discountType === "percentage") {
        const val = Number(data.discountValue);
        return val > 0 && val <= 100;
      }
      return true;
    },
    {
      message: "Percentage discount must be between 1 and 100",
      path: ["discountValue"],
    },
  )
  .refine(
    (data) => {
      const from = new Date(data.validFrom).getTime();
      const until = new Date(data.validUntil).getTime();
      return until > from;
    },
    {
      message: "validUntil must be after validFrom",
      path: ["validUntil"],
    },
  );

export const ALLOWED_STAFF_ROLES = new Set([
  "admin",
  "merchant:owner",
  "owner",
  "merchant:admin",
  "merchant:manager",
  "merchant:staff",
  "staff",
]);

export function isAuthorizedRole(roles: string[] = [], permissions: string[] = []): boolean {
  if (roles.some((role) => ALLOWED_STAFF_ROLES.has(role))) {
    return true;
  }
  if (permissions.includes("catalog:write") || permissions.includes("*")) {
    return true;
  }
  return false;
}

export function formatDiscountResponse(discount: Discount): Record<string, unknown> {
  return {
    id: discount.id,
    merchantId: discount.merchantId,
    code: discount.code,
    discountType: discount.discountType,
    discountValue: discount.discountValue,
    minOrderStroops: discount.minOrderStroops ?? undefined,
    maxUses: discount.maxUses ?? undefined,
    usesCount: discount.usesCount,
    validFrom: discount.validFrom instanceof Date ? discount.validFrom.toISOString() : String(discount.validFrom),
    validUntil: discount.validUntil instanceof Date ? discount.validUntil.toISOString() : String(discount.validUntil),
    isActive: discount.isActive,
    createdAt: discount.createdAt instanceof Date ? discount.createdAt.toISOString() : String(discount.createdAt),
    updatedAt: discount.updatedAt instanceof Date ? discount.updatedAt.toISOString() : String(discount.updatedAt),
  };
}

export async function createDiscountHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string> = {},
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const userContext = getAuthenticatedUserContext(req);
    const userRoles = userContext?.roles ?? [];
    const userPermissions = userContext?.permissions ?? [];

    const rawBody = await readJsonBody(req);
    const merchantId = params.merchantId ?? rawBody.merchantId ?? (req.headers["x-merchant-id"] as string | undefined);

    let merchant: Merchant | null = null;
    if (merchantId) {
      merchant = await Merchant.findByPk(merchantId);
      if (!merchant) {
        notFound(res, `Merchant '${merchantId}' not found`, req);
        return;
      }
    } else {
      merchant = await Merchant.findOne({
        where: { ownerUserId: auth.userId },
        order: [["createdAt", "DESC"]],
      });
      if (!merchant) {
        notFound(res, "No merchant profile found for authenticated user", req);
        return;
      }
    }

    const isOwner = merchant.ownerUserId === auth.userId;
    const hasStaffPrivileges = isAuthorizedRole(userRoles, userPermissions);

    // Enforce role authorization check: only merchant owners or authorized staff can create discounts
    if (!isOwner && !hasStaffPrivileges) {
      forbidden(res, "Forbidden: Only merchant owners or authorized staff can create discounts", req);
      return;
    }

    // Tenancy guard: if staff role is present but user is not platform admin and does not own the target merchant
    if (!isOwner && !userRoles.includes("admin") && !userRoles.some((r) => r.startsWith("merchant:"))) {
      forbidden(res, "Forbidden: You are not authorized to create discounts for this merchant store", req);
      return;
    }

    const validationResult = CreateDiscountSchema.safeParse(rawBody);
    if (!validationResult.success) {
      const details = validationResult.error.errors.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      badRequest(res, "Invalid request body", req, details);
      return;
    }

    const data: CreateDiscountDTO = validationResult.data;

    // Check for existing duplicate code for this merchant (HTTP 409)
    const existing = await Discount.findOne({
      where: {
        merchantId: merchant.id,
        code: data.code,
      },
    });

    if (existing) {
      sendApiError(
        res,
        409,
        "DUPLICATE_DISCOUNT_CODE",
        `A discount with code '${data.code}' already exists for this merchant`,
        req,
      );
      return;
    }

    try {
      const discount = await Discount.create({
        merchantId: merchant.id,
        code: data.code,
        discountType: data.discountType,
        discountValue: data.discountValue,
        minOrderStroops: data.minOrderStroops ?? null,
        maxUses: data.maxUses ?? null,
        usesCount: 0,
        validFrom: new Date(data.validFrom),
        validUntil: new Date(data.validUntil),
        isActive: true,
      });

      log.info("Discount created successfully", {
        discountId: discount.id,
        merchantId: merchant.id,
        code: discount.code,
        userId: auth.userId,
      });

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: formatDiscountResponse(discount),
          error: null,
        }),
      );
    } catch (createErr: any) {
      if (
        createErr?.name === "SequelizeUniqueConstraintError" ||
        createErr?.errors?.some((e: any) => e.type === "unique violation")
      ) {
        sendApiError(
          res,
          409,
          "DUPLICATE_DISCOUNT_CODE",
          `A discount with code '${data.code}' already exists for this merchant`,
          req,
        );
        return;
      }
      throw createErr;
    }
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to create discount", {
      error: err instanceof Error ? err.message : String(err),
      userId: extractAuth(req).userId,
    });
    sendApiError(
      res,
      500,
      "DISCOUNT_CREATE_FAILED",
      err instanceof Error ? err.message : "Failed to create discount",
      req,
    );
  }
}

export function registerDiscountRoutes(): Route[] {
  return [
    route("POST", "/api/v1/merchants/:merchantId/discounts", createDiscountHandler),
    route("POST", "/api/v1/discounts", createDiscountHandler),
  ];
}
