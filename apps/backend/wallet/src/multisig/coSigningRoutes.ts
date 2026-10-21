/**
 * Multi-Sig Dual-Control Co-Signing — HTTP routes
 * Issue #289
 *
 * POST   /multisig/cosigning/sessions                          – create session
 * GET    /multisig/cosigning/sessions/:sessionId               – get session
 * POST   /multisig/cosigning/sessions/:sessionId/signatures    – add signature
 * POST   /multisig/cosigning/sessions/:sessionId/submit        – combine + submit
 * POST   /multisig/cosigning/sessions/:sessionId/expire        – expire session
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { route, json, type Route } from "@delegolabs/utils";
import {
  addCoSignature,
  createCoSigningSession,
  createHorizonSubmitter,
  expireCoSigningSession,
  getCoSigningSession,
  submitCoSigningSession,
} from "./coSigningService.js";
import type { SubmitCombinedTransaction } from "./coSigningTypes.js";

async function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as T) : ({} as T));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function handleError(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : "Unknown error";
  const lower = message.toLowerCase();
  const status = lower.includes("not found")
    ? 404
    : lower.includes("already submitted") ||
        lower.includes("already expired") ||
        lower.includes("already ready")
      ? 409
      : 400;
  json(res, status, { data: null, error: { code: "COSIGNING_ERROR", message } });
}

function resolveSubmitter(): SubmitCombinedTransaction | undefined {
  // Opt-in on-chain submission; default records the combined envelope and
  // marks the session submitted without hitting Horizon (hermetic tests).
  if (process.env.CO_SIGNING_SUBMIT_TO_NETWORK === "true") {
    return createHorizonSubmitter();
  }
  return undefined;
}

export function registerCoSigningRoutes(): Route[] {
  return [
    route("POST", "/multisig/cosigning/sessions", async (req, res) => {
      try {
        const body = await readBody(req);
        const session = await createCoSigningSession(
          body as Parameters<typeof createCoSigningSession>[0],
        );
        json(res, 201, { data: session, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    route(
      "GET",
      "/multisig/cosigning/sessions/:sessionId",
      async (_req, res, params) => {
        try {
          const session = await getCoSigningSession(params.sessionId);
          if (!session) {
            json(res, 404, {
              data: null,
              error: {
                code: "COSIGNING_ERROR",
                message: `Co-signing session not found: ${params.sessionId}`,
              },
            });
            return;
          }
          json(res, 200, { data: session, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    route(
      "POST",
      "/multisig/cosigning/sessions/:sessionId/signatures",
      async (req, res, params) => {
        try {
          const body = await readBody<{
            signerAddress: string;
            signatureBase64: string;
          }>(req);
          const session = await addCoSignature(
            {
              sessionId: params.sessionId,
              signerAddress: body.signerAddress,
              signatureBase64: body.signatureBase64,
            },
            resolveSubmitter(),
          );
          json(res, 200, { data: session, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    route(
      "POST",
      "/multisig/cosigning/sessions/:sessionId/submit",
      async (_req, res, params) => {
        try {
          const session = await submitCoSigningSession(
            params.sessionId,
            resolveSubmitter(),
          );
          json(res, 200, { data: session, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    route(
      "POST",
      "/multisig/cosigning/sessions/:sessionId/expire",
      async (_req, res, params) => {
        try {
          const session = await expireCoSigningSession(params.sessionId);
          json(res, 200, { data: session, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),
  ];
}
