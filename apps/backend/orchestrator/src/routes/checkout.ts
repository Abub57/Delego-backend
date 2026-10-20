/**
 * Multi-merchant checkout routes
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { json, route } from "@delegolabs/utils";
import { orchestrateMultiMerchantCheckout, type MultiMerchantCheckoutRequest } from "../checkout.js";

async function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export async function multiMerchantCheckoutHandler(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readJsonBody(req) as MultiMerchantCheckoutRequest;

    if (typeof body.cartId !== "string" || typeof body.shippingAddressId !== "string" || typeof body.settlementCurrency !== "string") {
      json(res, 400, {
        data: null,
        error: {
          code: "VALIDATION_ERROR",
          message: "cartId, shippingAddressId, and settlementCurrency are required",
        },
      });
      return;
    }

    const result = await orchestrateMultiMerchantCheckout(body);

    json(res, 200, {
      data: result,
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    if (message.includes("Insufficient stock")) {
      json(res, 409, {
        data: null,
        error: {
          code: "INSUFFICIENT_STOCK",
          message,
        },
      });
      return;
    }
    json(res, 500, {
      data: null,
      error: {
        code: "INTERNAL_ERROR",
        message,
      },
    });
  }
}

export function createMultiMerchantCheckoutRoutes() {
  return [
    route("POST", "/api/v1/orders/multi-merchant/checkout", multiMerchantCheckoutHandler),
  ];
}
