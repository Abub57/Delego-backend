/**
 * Unit & Integration tests for Automated Testnet Faucet Dispenser (Issue #373)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Faucet24hRateLimiter,
  FaucetDispenserService,
  validateCaptchaToken,
  FAUCET_24H_WINDOW_SECONDS,
} from "../faucetDispenser.js";
import { registerFaucetRoutes, setFaucetDispenserService } from "../routes.js";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("@delegolabs/utils", async () => {
  const actual = await vi.importActual<typeof import("@delegolabs/utils")>("@delegolabs/utils");
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

const VALID_KEYPAIR_ADDR = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGXTURDM2PUOXEB2AH4";

const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
  ttl: vi.fn(),
};

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
};

function createMockReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json", ...headers };
  req.socket = { remoteAddress: "127.0.0.1" } as any;
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function createMockRes(): MockResponse {
  const res = {
    statusCode: 200,
    body: "",
    headers: {},
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      if (headers) this.headers = headers;
    },
    setHeader(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  };
  return res as unknown as MockResponse;
}

describe("Faucet24hRateLimiter (Issue #373)", () => {
  let rateLimiter: Faucet24hRateLimiter;

  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter = new Faucet24hRateLimiter(mockRedis as any);
  });

  it("allows first request for a new address and IP", async () => {
    mockRedis.get.mockResolvedValue(null);

    const check = await rateLimiter.checkRateLimit("GADDR1", "127.0.0.1");
    expect(check.allowed).toBe(true);

    await rateLimiter.recordRequest("GADDR1", "127.0.0.1");
    expect(mockRedis.setex).toHaveBeenCalledWith("faucet:ratelimit:24h:GADDR1", FAUCET_24H_WINDOW_SECONDS, "1");
    expect(mockRedis.setex).toHaveBeenCalledWith("faucet:ratelimit:24h:ip:127.0.0.1", FAUCET_24H_WINDOW_SECONDS, "1");
  });

  it("blocks request if destination address made a request in the last 24 hours", async () => {
    mockRedis.get
      .mockResolvedValueOnce("1") // address already seen
      .mockResolvedValueOnce(null); // IP not seen
    mockRedis.ttl.mockResolvedValue(43200); // 12 hours remaining

    const check = await rateLimiter.checkRateLimit("GADDR1", "192.168.1.1");
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("destination address");
    expect(check.retryAfterSeconds).toBe(43200);
  });

  it("blocks request if IP made a request in the last 24 hours", async () => {
    mockRedis.get
      .mockResolvedValueOnce(null) // address not seen
      .mockResolvedValueOnce("1"); // IP already seen
    mockRedis.ttl.mockResolvedValue(80000);

    const check = await rateLimiter.checkRateLimit("GADDR2", "127.0.0.1");
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("IP address");
    expect(check.retryAfterSeconds).toBe(80000);
  });
});

describe("validateCaptchaToken (Issue #373)", () => {
  it("validates bypass and test tokens directly", async () => {
    expect(await validateCaptchaToken("test-captcha-token")).toBe(true);
    expect(await validateCaptchaToken("bypass_12345")).toBe(true);
  });

  it("rejects empty / whitespace tokens", async () => {
    expect(await validateCaptchaToken("")).toBe(false);
    expect(await validateCaptchaToken("   ")).toBe(false);
  });
});

describe("FaucetDispenserService (Issue #373)", () => {
  let dispenser: FaucetDispenserService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    dispenser = new FaucetDispenserService(mockRedis as any, {
      skipCaptchaInDev: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects invalid destination addresses", async () => {
    const result = await dispenser.dispense(
      {
        destinationAddress: "INVALID_ADDRESS",
        clientToken: "test-captcha-token",
      },
      "127.0.0.1"
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("Invalid Stellar destination address");
  });

  it("rejects invalid CAPTCHA token", async () => {
    const strictDispenser = new FaucetDispenserService(mockRedis as any, {
      captchaSecret: "real-secret",
      skipCaptchaInDev: false,
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false }),
    }) as any;

    const result = await strictDispenser.dispense(
      {
        destinationAddress: VALID_KEYPAIR_ADDR,
        clientToken: "invalid-token",
      },
      "127.0.0.1"
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("CAPTCHA validation token");
  });

  it("enforces 24-hour rate limiting", async () => {
    mockRedis.get.mockResolvedValueOnce("1");
    mockRedis.ttl.mockResolvedValue(50000);

    const result = await dispenser.dispense(
      {
        destinationAddress: VALID_KEYPAIR_ADDR,
        clientToken: "test-captcha-token",
      },
      "127.0.0.1"
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("Rate limit");
  });

  it("disburses XLM via Friendbot on valid request and records 24h limit", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ hash: "tx_mock_hash_123" }),
    }) as any;

    const result = await dispenser.dispense(
      {
        destinationAddress: VALID_KEYPAIR_ADDR,
        tokenCode: "XLM",
        clientToken: "test-captcha-token",
      },
      "127.0.0.1"
    );

    expect(result.success).toBe(true);
    expect(result.amountFunded).toBe("10000.0000000");
    expect(result.tokenCode).toBe("XLM");
    expect(result.txHash).toBe("tx_mock_hash_123");
    expect(mockRedis.setex).toHaveBeenCalledTimes(2);
  });

  it("handles Friendbot failure gracefully", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Account already funded",
    }) as any;

    const result = await dispenser.dispense(
      {
        destinationAddress: VALID_KEYPAIR_ADDR,
        tokenCode: "XLM",
        clientToken: "test-captcha-token",
      },
      "127.0.0.1"
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("Friendbot funding failed");
  });

  it("returns error for unsupported token code", async () => {
    const result = await dispenser.dispense(
      {
        destinationAddress: VALID_KEYPAIR_ADDR,
        tokenCode: "UNKNOWN_TOKEN",
        clientToken: "test-captcha-token",
      },
      "127.0.0.1"
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("Unsupported token code");
  });
});

describe("POST /faucet/dispense HTTP route", () => {
  let dispenserMock: any;

  beforeEach(() => {
    dispenserMock = {
      dispense: vi.fn(),
    };
    setFaucetDispenserService(dispenserMock);
  });

  afterEach(() => {
    setFaucetDispenserService(null);
  });

  it("returns 200 with funding details on success", async () => {
    dispenserMock.dispense.mockResolvedValue({
      success: true,
      destinationAddress: VALID_KEYPAIR_ADDR,
      tokenCode: "XLM",
      amountFunded: "10000.0000000",
      txHash: "tx_123",
      message: "Testnet XLM funded successfully",
    });

    const routes = registerFaucetRoutes();
    const route = routes.find((r) => r.method === "POST" && r.pattern.test("/faucet/dispense"))!;

    const req = createMockReq(
      JSON.stringify({
        destinationAddress: VALID_KEYPAIR_ADDR,
        tokenCode: "XLM",
        clientToken: "test-captcha-token",
      })
    );
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.success).toBe(true);
    expect(body.data.amountFunded).toBe("10000.0000000");
  });

  it("returns 429 when rate limited", async () => {
    dispenserMock.dispense.mockResolvedValue({
      success: false,
      destinationAddress: VALID_KEYPAIR_ADDR,
      tokenCode: "XLM",
      amountFunded: "0",
      txHash: "",
      message: "Rate limit of 1 request per 24 hours exceeded",
    });

    const routes = registerFaucetRoutes();
    const route = routes.find((r) => r.method === "POST" && r.pattern.test("/faucet/dispense"))!;

    const req = createMockReq(
      JSON.stringify({
        destinationAddress: VALID_KEYPAIR_ADDR,
        clientToken: "test-captcha-token",
      })
    );
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("returns 400 when missing required fields", async () => {
    const routes = registerFaucetRoutes();
    const route = routes.find((r) => r.method === "POST" && r.pattern.test("/faucet/dispense"))!;

    const req = createMockReq(JSON.stringify({}));
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});
