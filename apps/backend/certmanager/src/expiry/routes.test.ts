import { describe, expect, it } from "vitest";
import type { Socket, AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { CertExpiryAlerter } from "@delegolabs/types";
import { startHttpServer } from "@delegolabs/utils";
import { CertExpiryChecker } from "./checker.js";
import { registerCertExpiryRoutes } from "../routes/certExpiryRoutes.js";

const NOW = new Date("2026-09-28T00:00:00Z");

function noopAlerter(): CertExpiryAlerter {
  return { emit: async () => true };
}

function fakeConnect(daysToExpiry: number) {
  return (opts: Record<string, unknown>, onSecureConnect: () => void) => {
    const socket = {
      getPeerCertificate: () => ({
        valid_to: new Date(NOW.getTime() + daysToExpiry * 24 * 60 * 60 * 1000).toUTCString(),
      }),
      end: () => undefined,
      destroy: () => undefined,
      on: () => undefined,
      setTimeout: () => undefined,
    } as unknown as Socket;
    queueMicrotask(onSecureConnect);
    return socket;
  };
}

function makeChecker(connectTls = fakeConnect(30)) {
  return new CertExpiryChecker({
    alerter: noopAlerter(),
    now: () => NOW,
    connectTls,
  });
}

let server: Server | null = null;
const servers: Server[] = [];

async function listen(routes: ReturnType<typeof registerCertExpiryRoutes>): Promise<string> {
  const srv = startHttpServer({ port: 0, serviceName: "certmanager-test", routes });
  servers.push(srv);
  server = srv;
  await new Promise<void>((resolve) => srv.on("listening", resolve));
  const addr = srv.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function request(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

describe("cert expiry routes", () => {
  it("GET /api/v1/certificates/expiry/domains lists registered domains", async () => {
    const checker = makeChecker();
    checker.registerDomain("m1", "shop.example.com");
    const base = await listen(registerCertExpiryRoutes(checker));

    const { status, json } = await request(base, "GET", "/api/v1/certificates/expiry/domains");
    expect(status).toBe(200);
    expect(json.data).toEqual([{ merchantId: "m1", domain: "shop.example.com" }]);
  });

  it("POST /api/v1/certificates/expiry/domains registers a domain", async () => {
    const checker = makeChecker();
    const base = await listen(registerCertExpiryRoutes(checker));

    const { status, json } = await request(base, "POST", "/api/v1/certificates/expiry/domains", {
      merchantId: "m9",
      domain: "new.example.com",
    });
    expect(status).toBe(201);
    expect(json.data).toEqual({ merchantId: "m9", domain: "new.example.com" });
    expect(checker.listDomains()).toHaveLength(1);
  });

  it("POST /api/v1/certificates/expiry/domains rejects missing fields", async () => {
    const base = await listen(registerCertExpiryRoutes(makeChecker()));
    const { status, json } = await request(base, "POST", "/api/v1/certificates/expiry/domains", {
      merchantId: "m9",
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("BAD_REQUEST");
  });

  it("DELETE /api/v1/certificates/expiry/domains/:domain removes a domain", async () => {
    const checker = makeChecker();
    checker.registerDomain("m1", "shop.example.com");
    const base = await listen(registerCertExpiryRoutes(checker));

    const { status } = await request(base, "DELETE", "/api/v1/certificates/expiry/domains/shop.example.com");
    expect(status).toBe(200);
    expect(checker.listDomains()).toHaveLength(0);

    const again = await request(base, "DELETE", "/api/v1/certificates/expiry/domains/shop.example.com");
    expect(again.status).toBe(404);
  });

  it("GET /api/v1/certificates/expiry/:domain probes one domain", async () => {
    const checker = makeChecker(fakeConnect(9));
    checker.registerDomain("m1", "shop.example.com");
    const base = await listen(registerCertExpiryRoutes(checker));

    const { status, json } = await request(base, "GET", "/api/v1/certificates/expiry/shop.example.com");
    expect(status).toBe(200);
    expect(json.data.status).toBe("expiring_soon");
    expect(json.data.certStatus.daysRemaining).toBe(9);
  });

  it("GET /api/v1/certificates/expiry/:domain 404s for unmonitored domains", async () => {
    const base = await listen(registerCertExpiryRoutes(makeChecker()));
    const { status, json } = await request(base, "GET", "/api/v1/certificates/expiry/unknown.example.com");
    expect(status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  it("GET /api/v1/certificates/expiry runs a full sweep", async () => {
    const checker = new CertExpiryChecker({
      alerter: noopAlerter(),
      now: () => NOW,
      connectTls: (opts, cb) => {
        const host = (opts as { host: string }).host;
        return fakeConnect(host.startsWith("soon.") ? 5 : 60)(opts, cb);
      },
    });
    checker.registerDomains([
      { merchantId: "m1", domain: "healthy.example.com" },
      { merchantId: "m2", domain: "soon.example.com" },
    ]);
    const base = await listen(registerCertExpiryRoutes(checker));

    const { status, json } = await request(base, "GET", "/api/v1/certificates/expiry");
    expect(status).toBe(200);
    expect(json.data.checked).toBe(2);
    expect(json.data.expiringSoon).toBe(1);
    expect(json.data.alertsEmitted).toBe(1);
  });
});
