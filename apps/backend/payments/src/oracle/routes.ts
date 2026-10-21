/**
 * Issue #369 — Oracle HTTP routes.
 *
 *   POST /oracle/delivery-receipts
 *     Sign a delivery receipt with the HSM-backed oracle key and (optionally)
 *     submit it to the escrow contract. Body: {@link OracleDeliveryReceiptInput}.
 *     Query param `submit=true` toggles contract submission.
 *
 *   POST /oracle/delivery-receipts/verify
 *     Verify a previously-issued receipt locally (no signing).
 *
 *   GET  /oracle/public-key
 *     Expose the oracle public key so the escrow contract can be registered
 *     with it and so callers can verify receipts.
 */

import type { IncomingMessage } from "node:/http";
import { json, readBodyWithLimit, route, type Route } from "@delegolabs/utils";
import { getOracleSigner } from "./config.js";
import { signDeliveryReceipt, verifyDeliveryReceipt } from "./service.js";
import type { OracleDeliveryReceiptInput, OracleSignedDeliveryReceipt } from "./types.js";

const MAX_BODY_BYTES = 64 * 1024; // 64 KiB — receipts are small.

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBodyWithLimit(req, MAX_BODY_BYTES);
  try {
    return body ? (JSON.parse(body) as Record<string, unknown>) : {};
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function parseOracleInput(body: Record<string, unknown>): OracleDeliveryReceiptInput {
  const escrowId = body.escrowId;
  const trackingNumber = body.trackingNumber;
  const carrier = body.carrier;
  const deliveredAt = body.deliveredAt;
  const oraclePublicKey = body.oraclePublicKey;

  if (
    typeof trackingNumber !== "string" ||
    !trackingNumber ||
    typeof carrier !== "string" ||
    !carrier
  ) {
    throw new Error("trackingNumber and carrier are required");
  }
  if (typeof oraclePublicKey !== "string" || !oraclePublicKey) {
    throw new Error("oraclePublicKey is required");
  }

  let escrowIdBig: bigint;
  if (typeof escrowId === "bigint") {
    escrowIdBig = escrowId;
  } else if (typeof escrowId === "number" && Number.isInteger(escrowId)) {
    escrowIdBig = BigInt(escrowId);
  } else if (typeof escrowId === "string" && /^\d+$/.test(escrowId.trim())) {
    escrowIdBig = BigInt(escrowId.trim());
  } else {
    throw new Error("escrowId must be a non-negative integer");
  }
  if (escrowIdBig < 0n) {
    throw new Error("escrowId must be non-negative");
  }

  let deliveredAtNum: number;
  if (typeof deliveredAt === "number" && Number.isInteger(deliveredAt)) {
    deliveredAtNum = deliveredAt;
  } else if (typeof deliveredAt === "string" && /^\d+$/.test(deliveredAt.trim())) {
    deliveredAtNum = Number.parseInt(deliveredAt.trim(), 10);
  } else {
    throw new Error("deliveredAt must be a non-negative integer (epoch seconds)");
  }
  if (deliveredAtNum < 0) {
    throw new Error("deliveredAt must be non-negative");
  }

  return {
    escrowId: escrowIdBig,
    trackingNumber,
    carrier,
    deliveredAt: deliveredAtNum,
    oraclePublicKey,
  };
}

export function registerOracleRoutes(): Route[] {
  return [
    route("GET", "/oracle/public-key", async (_req, res) => {
      try {
        const signer = getOracleSigner();
        const publicKey = await signer.getPublicKey();
        json(res, 200, {
          data: {
            publicKey,
            provider: signer.provider,
            keyId: signer.keyId,
            algorithm: "ed25519",
          },
          error: null,
        });
      } catch (err) {
        json(res, 503, {
          data: null,
          error: {
            code: "ORACLE_SIGNER_UNAVAILABLE",
            message: err instanceof Error ? err.message : "Oracle signer unavailable",
          },
        });
      }
    }),

    route("POST", "/oracle/delivery-receipts", async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const input = parseOracleInput(body);
        const submit = req.url?.includes("submit=true") ?? false;
        const result = await signDeliveryReceipt(input, { submitToContract: submit });
        json(res, 200, { data: result, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          json(res, 400, { data: null, error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } });
          return;
        }
        json(res, 400, {
          data: null,
          error: { code: "ORACLE_SIGN_FAILED", message: err instanceof Error ? err.message : "Signing failed" },
        });
      }
    }),

    route("POST", "/oracle/delivery-receipts/verify", async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const receipt = body.receipt as OracleSignedDeliveryReceipt | undefined;
        if (!receipt || typeof receipt !== "object") {
          json(res, 400, {
            data: null,
            error: { code: "VALIDATION_ERROR", message: "receipt object is required" },
          });
          return;
        }
        const valid = await verifyDeliveryReceipt(receipt);
        json(res, 200, { data: { valid }, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          json(res, 400, { data: null, error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } });
          return;
        }
        json(res, 400, {
          data: null,
          error: { code: "ORACLE_VERIFY_FAILED", message: err instanceof Error ? err.message : "Verification failed" },
        });
      }
    }),
  ];
}
