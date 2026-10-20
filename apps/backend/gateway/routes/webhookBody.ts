/**
 * Raw body capture for courier webhooks (Issue #577).
 *
 * The gateway chain attaches body listeners (bodyLimitMiddleware) and awaits
 * Redis before routes run, so the request stream is already drained when the
 * route handler runs. This middleware must be mounted before
 * bodyLimitMiddleware. It buffers the exact bytes for the HMAC check.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export const COURIER_WEBHOOK_PREFIX = "/api/v1/courier/webhooks/";
export const COURIER_WEBHOOK_BODY_LIMIT_BYTES = 100 * 1024;

const captured = new WeakMap<IncomingMessage, Buffer>();

/** The raw bytes captured for this request, if the middleware ran. */
export function getCapturedBody(req: IncomingMessage): Buffer | undefined {
  return captured.get(req);
}

function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  if (res.headersSent) return;
  res.once("finish", () => req.destroy());
  res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
  res.end(
    JSON.stringify({
      data: null,
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit" },
    }),
  );
}

export function courierWebhookBodyCapture(
  limitBytes: number = COURIER_WEBHOOK_BODY_LIMIT_BYTES,
) {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const isCarrierPath =
      pathname.startsWith(COURIER_WEBHOOK_PREFIX) &&
      pathname.length > COURIER_WEBHOOK_PREFIX.length &&
      !pathname.slice(COURIER_WEBHOOK_PREFIX.length).includes("/");
    if ((req.method ?? "GET").toUpperCase() !== "POST" || !isCarrierPath) {
      next();
      return;
    }

    const declared = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
    if (Number.isFinite(declared) && declared > limitBytes) {
      tooLarge(req, res);
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    req.on("data", (chunk: Buffer | string) => {
      if (done) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > limitBytes) {
        done = true;
        tooLarge(req, res);
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      captured.set(req, Buffer.concat(chunks));
      next();
    });
    req.on("error", () => {
      if (done) return;
      done = true;
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: null,
          error: { code: "INVALID_PAYLOAD", message: "Could not read request body" },
        }),
      );
    });
  };
}
// END-OF-FILE-MARKER
