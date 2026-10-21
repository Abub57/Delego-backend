/**
 * Faucet Dispenser HTTP Routes (Issue #373 & Issue #286)
 */

import type { IncomingMessage } from "node:http";
import { route, json, readBodyWithLimit, PayloadTooLargeError, type Route } from "@delegolabs/utils";
import type { FaucetRequest } from "@delegolabs/types";
import { getRedisConnection } from "../queue/txQueue.js";
import { FaucetDispenserService } from "./faucetDispenser.js";

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const body = await readBodyWithLimit(req);
  try {
    return body ? (JSON.parse(body) as T) : ({} as T);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "127.0.0.1";
}

let dispenserService: FaucetDispenserService | null = null;

export function getFaucetDispenserService(): FaucetDispenserService {
  if (!dispenserService) {
    const redis = getRedisConnection();
    dispenserService = new FaucetDispenserService(redis);
  }
  return dispenserService;
}

export function setFaucetDispenserService(service: FaucetDispenserService | null): void {
  dispenserService = service;
}

export function registerFaucetRoutes(): Route[] {
  return [
    // POST /faucet/dispense - Automated Testnet Faucet Dispenser with Rate Limiting (Issue #373)
    route("POST", "/faucet/dispense", async (req, res) => {
      try {
        const body = await readJsonBody<Partial<FaucetRequest>>(req);
        const { destinationAddress, tokenCode, clientToken } = body;

        if (!destinationAddress || typeof destinationAddress !== "string") {
          json(res, 400, {
            data: null,
            error: {
              code: "VALIDATION_ERROR",
              message: "destinationAddress is required",
            },
          });
          return;
        }

        if (!clientToken || typeof clientToken !== "string") {
          json(res, 400, {
            data: null,
            error: {
              code: "VALIDATION_ERROR",
              message: "clientToken (CAPTCHA) is required",
            },
          });
          return;
        }

        const clientIp = getClientIp(req);
        const service = getFaucetDispenserService();
        const result = await service.dispense(
          {
            destinationAddress,
            tokenCode: tokenCode || "XLM",
            clientToken,
          },
          clientIp
        );

        if (!result.success) {
          const isRateLimited = result.message?.toLowerCase().includes("rate limit");
          const isCaptchaFailed = result.message?.toLowerCase().includes("captcha");
          const statusCode = isRateLimited ? 429 : isCaptchaFailed ? 403 : 400;

          json(res, statusCode, {
            data: null,
            error: {
              code: isRateLimited ? "RATE_LIMITED" : isCaptchaFailed ? "CAPTCHA_FAILED" : "FAUCET_ERROR",
              message: result.message,
            },
          });
          return;
        }

        json(res, 200, { data: result, error: null });
      } catch (err: any) {
        if (err instanceof PayloadTooLargeError) {
          json(res, 413, {
            data: null,
            error: { code: "PAYLOAD_TOO_LARGE", message: err.message },
          });
          return;
        }
        if (err.message === "Invalid JSON body") {
          json(res, 400, {
            data: null,
            error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" },
          });
          return;
        }
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),
  ];
}
