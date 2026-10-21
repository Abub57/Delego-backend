import { describe, expect, it } from "vitest";
import { httpHealthCheck } from "./httpCheck.js";

describe("httpHealthCheck", () => {
  it("reports healthy for a 2xx endpoint", async () => {
    const check = httpHealthCheck({
      url: "http://svc.test/health",
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    const result = await check();
    expect(result?.status).toBe("healthy");
  });

  it("reports degraded when the endpoint responds with an error status", async () => {
    const check = httpHealthCheck({
      url: "http://svc.test/health",
      fetchImpl: async () => new Response("down", { status: 503 }),
    });
    const result = await check();
    expect(result?.status).toBe("degraded");
    expect(result?.details?.httpStatus).toBe(503);
  });

  it("throws (unhealthy) when the endpoint is unreachable", async () => {
    const check = httpHealthCheck({
      url: "http://svc.test/health",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(check()).rejects.toThrow("ECONNREFUSED");
  });

  it("evaluates bodyStatus when provided", async () => {
    const check = httpHealthCheck({
      url: "http://svc.test/health",
      fetchImpl: async () => new Response(JSON.stringify({ status: "degraded" }), { status: 200 }),
      bodyStatus: (body) => (body as { status?: string }).status === "ok" ? "healthy" : "degraded",
    });
    const result = await check();
    expect(result?.status).toBe("degraded");
  });

  it("forwards a POST body and evaluates a JSON-RPC bodyStatus", async () => {
    let seenMethod: string | undefined;
    let seenBody: string | undefined;
    let seenContentType: string | undefined;

    const check = httpHealthCheck({
      url: "http://rpc.test/",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        seenMethod = init?.method;
        seenBody = init?.body as string;
        seenContentType = (init?.headers as Record<string, string>)["Content-Type"];
        return new Response(JSON.stringify({ result: { status: "healthy" } }), { status: 200 });
      }) as typeof fetch,
      bodyStatus: (body) =>
        (body as { result?: { status?: string } })?.result?.status === "healthy"
          ? "healthy"
          : "degraded",
    });

    const result = await check();

    expect(seenMethod).toBe("POST");
    expect(seenContentType).toBe("application/json");
    expect(JSON.parse(seenBody ?? "{}")).toMatchObject({ method: "getHealth" });
    expect(result?.status).toBe("healthy");
  });

  it("reports degraded when a JSON-RPC body reports an error result", async () => {
    const check = httpHealthCheck({
      url: "http://rpc.test/",
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: -32603, message: "unavailable" } }), {
          status: 200,
        }),
      bodyStatus: (body) =>
        (body as { result?: { status?: string } })?.result?.status === "healthy"
          ? "healthy"
          : "degraded",
    });
    const result = await check();
    expect(result?.status).toBe("degraded");
  });
});
