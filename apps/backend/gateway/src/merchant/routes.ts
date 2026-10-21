import type { IncomingMessage, ServerResponse } from "node:http";
import { Op } from "sequelize";
import type { Route } from "@delegolabs/utils";
import { route, createLogger, validatePublicKey } from "@delegolabs/utils";
import { extractAuth } from "../../middleware/auth.js";
import { validateSchema, CreateMerchantSchema, UpdateMerchantSchema } from "../../src/validation.js";
import { readJsonBody, InvalidJsonError, BodyTooLargeError } from "../../src/request.js";
import { badRequest, notFound, unauthorized, forbidden, sendApiError } from "../../src/errors.js";
import { Merchant } from "../../src/models/index.js";

const log = createLogger("gateway:merchant", process.env.LOG_LEVEL ?? "info");

function formatMerchantResponse(merchant: Merchant): Record<string, unknown> {
  return {
    id: merchant.id,
    ownerUserId: merchant.ownerUserId,
    storeName: merchant.storeName,
    description: merchant.description,
    stellarAddress: merchant.stellarAddress,
    contactEmail: merchant.contactEmail,
    category: merchant.category,
    isVerified: merchant.isVerified,
    reputationScore: merchant.reputationScore,
    createdAt: merchant.createdAt.toISOString(),
    updatedAt: merchant.updatedAt.toISOString(),
  };
}

export async function createMerchantHandler(
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
    const validation = validateSchema(CreateMerchantSchema, body);
    if (!validation.valid) {
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    const stellarValidation = validatePublicKey(body.stellarAddress);
    if (!stellarValidation.valid) {
      const message = stellarValidation.error === "secret_key_not_allowed"
        ? "Secret key values are not allowed as Stellar address"
        : "Invalid Stellar address format: must be 56 characters starting with 'G'";
      badRequest(res, message, req);
      return;
    }

    try {
      const merchant = await Merchant.create({
        ownerUserId: auth.userId,
        storeName: body.storeName,
        description: body.description ?? null,
        stellarAddress: stellarValidation.normalized ?? body.stellarAddress,
        contactEmail: body.contactEmail,
        category: body.category,
      });

      log.info("Merchant created", { merchantId: merchant.id, userId: auth.userId });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: formatMerchantResponse(merchant),
        error: null,
      }));
    } catch (createErr: any) {
      if (createErr?.name === "SequelizeUniqueConstraintError" ||
          createErr?.errors?.some((e: any) => e.type === "unique violation" && e.path === "stellar_address")) {
        sendApiError(res, 409, "DUPLICATE_STELLAR_ADDRESS",
          "A merchant with this Stellar address already exists", req);
        return;
      }
      throw createErr;
    }
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to create merchant", {
      error: err instanceof Error ? err.message : String(err),
      userId: extractAuth(req).userId,
    });
    sendApiError(res, 500, "MERCHANT_CREATE_FAILED",
      err instanceof Error ? err.message : "Failed to create merchant", req);
  }
}

export async function getCurrentMerchantHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const merchant = await Merchant.findOne({
      where: { ownerUserId: auth.userId },
      order: [["createdAt", "DESC"]],
    });

    if (!merchant) {
      notFound(res, "No merchant profile found for current user", req);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: formatMerchantResponse(merchant),
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to fetch current merchant", {
      error: err instanceof Error ? err.message : String(err),
      userId: extractAuth(req).userId,
    });
    sendApiError(res, 500, "MERCHANT_FETCH_FAILED",
      err instanceof Error ? err.message : "Failed to fetch merchant", req);
  }
}

export async function updateCurrentMerchantHandler(
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
    const validation = validateSchema(UpdateMerchantSchema, body);
    if (!validation.valid) {
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    const merchant = await Merchant.findOne({
      where: { ownerUserId: auth.userId },
      order: [["createdAt", "DESC"]],
    });

    if (!merchant) {
      notFound(res, "No merchant profile found for current user", req);
      return;
    }

    const updateFields: Partial<Merchant> = {};
    if (body.storeName !== undefined) updateFields.storeName = body.storeName;
    if (body.description !== undefined) updateFields.description = body.description;
    if (body.contactEmail !== undefined) updateFields.contactEmail = body.contactEmail;
    if (body.category !== undefined) updateFields.category = body.category;

    await merchant.update(updateFields);
    await merchant.reload();

    log.info("Merchant updated", { merchantId: merchant.id, userId: auth.userId });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: formatMerchantResponse(merchant),
      error: null,
    }));
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to update merchant", {
      error: err instanceof Error ? err.message : String(err),
      userId: extractAuth(req).userId,
    });
    sendApiError(res, 500, "MERCHANT_UPDATE_FAILED",
      err instanceof Error ? err.message : "Failed to update merchant", req);
  }
}

export function registerMerchantRoutes(): Route[] {
  return [
    route("POST", "/api/v1/merchants", createMerchantHandler),
    route("GET", "/api/v1/merchants/me", getCurrentMerchantHandler),
    route("PUT", "/api/v1/merchants/me", updateCurrentMerchantHandler),
  ];
}
