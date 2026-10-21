import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteHandler } from "@delegolabs/utils";
import { json } from "@delegolabs/utils";
import { MerchantProfileUpdateSchema } from "@delegolabs/types";
import { QueryTypes } from "sequelize";
import { extractAuth } from "../middleware/auth.js";
import { sequelize } from "../src/db.js";
import { User } from "../src/models/User.js";
import { BodyTooLargeError, readJsonBody } from "../src/request.js";

interface MerchantProfile {
  id: string;
  displayName: string;
  description: string;
  supportEmail: string | null;
  webhookUrl: string | null;
}

export const updateMerchantProfileHandler: RouteHandler = async (
  req: IncomingMessage,
  res: ServerResponse,
  params,
): Promise<void> => {
  const auth = extractAuth(req);
  if (!auth.userId) {
    json(res, 401, {
      data: null,
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = error instanceof BodyTooLargeError ? 413 : 400;
    const message =
      error instanceof Error ? error.message : "Invalid request body";
    json(res, status, {
      data: null,
      error: {
        code: status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_JSON",
        message,
      },
    });
    return;
  }

  const parsed = MerchantProfileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, {
      data: null,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid merchant profile update",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "body",
          message: issue.message,
          code: issue.code,
        })),
      },
    });
    return;
  }

  const merchantId = params.merchantId;
  if (!merchantId) {
    json(res, 400, {
      data: null,
      error: {
        code: "MISSING_MERCHANT_ID",
        message: "merchantId path parameter is required",
      },
    });
    return;
  }

  try {
    const user = await User.findByPk(auth.userId, {
      attributes: ["stellarAddress"],
    });
    if (!user?.stellarAddress) {
      json(res, 403, {
        data: null,
        error: {
          code: "FORBIDDEN",
          message: "No merchant profile is linked to this account",
        },
      });
      return;
    }

    const { displayName, description, supportEmail, webhookUrl } = parsed.data;
    const assignments: string[] = [];
    const replacements: Record<string, string> = {
      merchantId,
      stellarAddress: user.stellarAddress,
    };

    if (displayName !== undefined) {
      assignments.push("name = :displayName");
      replacements.displayName = displayName;
    }
    if (description !== undefined) {
      assignments.push("description = :description");
      replacements.description = description;
    }
    if (supportEmail !== undefined) {
      assignments.push("support_email = :supportEmail");
      replacements.supportEmail = supportEmail;
    }
    if (webhookUrl !== undefined) {
      assignments.push("webhook_url = :webhookUrl");
      replacements.webhookUrl = webhookUrl;
    }

    const profiles = await sequelize.query<MerchantProfile>(
      `UPDATE merchants
       SET ${assignments.join(", ")}, updated_at = NOW()
       WHERE id = :merchantId AND stellar_address = :stellarAddress
       RETURNING id, name AS "displayName", description,
                 support_email AS "supportEmail", webhook_url AS "webhookUrl"`,
      { replacements, type: QueryTypes.SELECT },
    );
    const profile = profiles[0];

    if (!profile) {
      json(res, 404, {
        data: null,
        error: { code: "NOT_FOUND", message: "Merchant profile not found" },
      });
      return;
    }

    json(res, 200, { data: profile, error: null });
  } catch (error) {
    json(res, 500, {
      data: null,
      error: {
        code: "MERCHANT_PROFILE_UPDATE_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Failed to update merchant profile",
      },
    });
  }
};
