/**
 * HTTP routes for certificate expiry monitoring (Issue #390).
 */
import { json, route, type Route } from "@delegolabs/utils";
import type { IncomingMessage } from "node:http";
import type { CertExpiryChecker } from "../expiry/checker.js";

export function registerCertExpiryRoutes(checker: CertExpiryChecker): Route[] {
  return [
    route("GET", "/api/v1/certificates/expiry", async (_req, res) => {
      const summary = await checker.checkAllDomains();
      json(res, 200, { data: summary, error: null });
    }),
    // NOTE: literal /domains routes must precede the /:domain wildcard route,
    // otherwise "domains" matches as a domain name (first match wins).
    route("GET", "/api/v1/certificates/expiry/domains", async (_req, res) => {
      json(res, 200, { data: checker.listDomains(), error: null });
    }),
    route("POST", "/api/v1/certificates/expiry/domains", async (req, res) => {
      const body = await readJson<{ merchantId?: string; domain?: string }>(req);
      if (!body.merchantId || !body.domain) {
        json(res, 400, {
          data: null,
          error: { code: "BAD_REQUEST", message: "merchantId and domain are required" },
        });
        return;
      }
      checker.registerDomain(body.merchantId, body.domain);
      json(res, 201, {
        data: { merchantId: body.merchantId, domain: body.domain },
        error: null,
      });
    }),
    route("DELETE", "/api/v1/certificates/expiry/domains/:domain", async (_req, res, params) => {
      const removed = checker.unregisterDomain(params.domain);
      if (!removed) {
        json(res, 404, {
          data: null,
          error: { code: "NOT_FOUND", message: `domain not monitored: ${params.domain}` },
        });
        return;
      }
      json(res, 200, { data: { domain: params.domain, removed: true }, error: null });
    }),
    route("GET", "/api/v1/certificates/expiry/:domain", async (_req, res, params) => {
      const entry = checker
        .listDomains()
        .find((d) => d.domain.toLowerCase() === params.domain.toLowerCase());
      if (!entry) {
        json(res, 404, {
          data: null,
          error: { code: "NOT_FOUND", message: `domain not monitored: ${params.domain}` },
        });
        return;
      }
      const { result } = await checker.checkDomain(entry.merchantId, entry.domain);
      json(res, 200, { data: result, error: null });
    }),
  ];
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return (text ? JSON.parse(text) : {}) as T;
}
