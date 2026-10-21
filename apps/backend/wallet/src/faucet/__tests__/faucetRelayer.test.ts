import { describe, it, expect, vi, beforeEach } from "vitest";
import { FaucetRateLimiter, FaucetRelayer } from "../faucetRelayer.js";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const VALID_ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGXTURDM2PUOXEB2AH4";

const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
  ttl: vi.fn(),
};

describe("FaucetRateLimiter", () => {
  let limiter: FaucetRateLimiter;

  beforeEach(() => {
    vi.clearAllMocks();
    limiter = new FaucetRateLimiter(mockRedis as any);
  });

  it("should allow first request for new address + IP", async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await limiter.checkAndRecord(VALID_ADDRESS, "192.168.1.1");

    expect(result.allowed).toBe(true);
    expect(mockRedis.setex).toHaveBeenCalledTimes(2);
  });

  it("should block second request from same address within window", async () => {
    mockRedis.get
      .mockResolvedValueOnce("1") // address already seen
      .mockResolvedValueOnce(null); // IP not seen
    mockRedis.ttl.mockResolvedValue(3000);

    const result = await limiter.checkAndRecord(VALID_ADDRESS, "192.168.1.2");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("address");
    expect(result.retryAfterSeconds).toBe(3000);
  });

  it("should block second request from same IP within window", async () => {
    mockRedis.get
      .mockResolvedValueOnce(null) // address not seen
      .mockResolvedValueOnce("1"); // IP already seen
    mockRedis.ttl.mockResolvedValue(2500);

    const result = await limiter.checkAndRecord(VALID_ADDRESS, "192.168.1.1");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("IP");
  });

  it("should get remaining limit time", async () => {
    mockRedis.ttl.mockResolvedValue(1800);
    const remaining = await limiter.getRemainingLimit(VALID_ADDRESS);
    expect(remaining).toBe(1800);
  });
});

describe("FaucetRelayer", () => {
  let relayer: FaucetRelayer;
  const mockLimiter = {
    checkAndRecord: vi.fn(),
    getRemainingLimit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLimiter.checkAndRecord.mockResolvedValue({ allowed: true });
    relayer = new FaucetRelayer(mockRedis as any, { rateLimiter: mockLimiter as any });
  });

  it("should reject invalid Stellar address", async () => {
    const result = await relayer.relay({ destinationAddress: "INVALID" }, "10.0.0.1");

    expect(result.success).toBe(false);
    expect(result.xlmFunded).toBe("0");
  });

  it("should reject when rate limited", async () => {
    mockLimiter.checkAndRecord.mockResolvedValue({
      allowed: false,
      reason: "Rate limit exceeded",
    });

    const result = await relayer.relay({ destinationAddress: VALID_ADDRESS }, "10.0.0.1");

    expect(result.success).toBe(false);
  });

  it("should call Friendbot for valid request", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result_xdr: "AAAAAAA" }),
    }) as any;

    const result = await relayer.relay({ destinationAddress: VALID_ADDRESS }, "10.0.0.1");

    expect(result.success).toBe(true);
    expect(result.xlmFunded).toBe("10000.0000000");
    expect(fetch).toHaveBeenCalledWith(
      `https://friendbot.stellar.org?addr=${VALID_ADDRESS}`,
      { method: "GET" },
    );
  });

  it("should handle Friendbot failure gracefully", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Already funded",
    }) as any;

    const result = await relayer.relay({ destinationAddress: VALID_ADDRESS }, "10.0.0.1");

    expect(result.success).toBe(false);
    expect(result.xlmFunded).toBe("0");
  });

  it("should handle Friendbot network error", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as any;

    const result = await relayer.relay({ destinationAddress: VALID_ADDRESS }, "10.0.0.1");

    expect(result.success).toBe(false);
  });
});
