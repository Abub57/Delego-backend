import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractAuth, getAuthenticatedUserContext } from "../../../gateway/middleware/auth.js";
import { createMerchantRevenueHandler, parseRevenueAggregateQuery } from "./merchantRevenue.js";

vi.mock("../../../gateway/middleware/auth.js", () => ({
  extractAuth: vi.fn(),
  getAuthenticatedUserContext: vi.fn(),
}));
// The shared error helper imports gateway-only dependencies in this workspace.
vi.mock("../../../gateway/src/errors.js", () => {
  const send = (res: ServerResponse, status: number, code: string, message: string, details?: unknown) => {
    res.writeHead(status);
    res.end(JSON.stringify({ error: { code, message, details } }));
  };
  return {
    sendApiError: send,
    badRequest: (res: ServerResponse, message: string, _req: unknown, details?: unknown) =>
      send(res, 400, "VALIDATION_ERROR", message, details),
    unauthorized: (res: ServerResponse) => send(res, 401, "UNAUTHORIZED", "Authentication required"),
    forbidden: (res: ServerResponse) => send(res, 403, "FORBIDDEN", "Forbidden"),
  };
});
vi.mock("../db.js", () => ({ sequelize: {} }));
vi.mock("../redisClient.js", () => ({ getRedisClient: vi.fn() }));

const USER = "00000000-0000-4000-8000-000000000001";
const MERCHANT = "6f1c2a9e-1b2c-4d3e-8f00-0123456789ab";
const VALID = `merchantId=${MERCHANT}&startDate=2026-09-01&endDate=2026-09-30&groupBy=week&currency=usdc`;

function makeHandler(isOwner = true) {
  const service = {
    getRevenueAggregates: vi.fn(async () => ({
      merchantId: MERCHANT,
      currency: "USDC",
      groupBy: "week" as const,
      rangeStart: "2026-08-31T00:00:00.000Z",
      rangeEnd: "2026-10-05T00:00:00.000Z",
      buckets: [],
      totals: {
        grossVolumeStroops: "9007199254740993",
        netRevenueStroops: "9007199254740993",
        platformFeesStroops: "0",
        refundedStroops: "0",
        orderCount: 1,
      },
    })),
  };
  const ownerCheck = vi.fn(async () => isOwner);
  return { handler: createMerchantRevenueHandler({ service, isOwner: ownerCheck }), service, ownerCheck };
}

async function call(handler: ReturnType<typeof makeHandler>["handler"], query: string) {
  const req = { url: `/api/v1/merchant/analytics/revenue?${query}`, headers: {} } as IncomingMessage;
  const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
  await handler(req, res, {});
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(extractAuth).mockReturnValue({ userId: USER, token: "token" });
  vi.mocked(getAuthenticatedUserContext).mockReturnValue({ userId: USER, email: "", roles: [], permissions: [] });
});

describe("parseRevenueAggregateQuery", () => {
  it("normalizes a valid query", () => {
    const parsed = parseRevenueAggregateQuery(new URLSearchParams(VALID));
    expect(parsed).toEqual({
      ok: true,
      value: {
        merchantId: MERCHANT,
        currency: "USDC",
        groupBy: "week",
        startDate: "2026-09-01T00:00:00.000Z",
        endDate: "2026-09-30T00:00:00.000Z",
      },
    });
  });

  it("defaults groupBy to day", () => {
    const parsed = parseRevenueAggregateQuery(
      new URLSearchParams(`merchantId=${MERCHANT}&startDate=2026-09-01&endDate=2026-09-02&currency=EURC`)
    );
    expect(parsed.ok && parsed.value.groupBy).toBe("day");
  });

  it.each([
    ["missing merchantId", `startDate=2026-09-01&endDate=2026-09-30&currency=USDC`],
    ["non-uuid merchantId", `merchantId=abc&startDate=2026-09-01&endDate=2026-09-30&currency=USDC`],
    ["missing currency", `merchantId=${MERCHANT}&startDate=2026-09-01&endDate=2026-09-30`],
    ["bad currency", `merchantId=${MERCHANT}&startDate=2026-09-01&endDate=2026-09-30&currency=US-DC`],
    ["bad groupBy", `merchantId=${MERCHANT}&startDate=2026-09-01&endDate=2026-09-30&currency=USDC&groupBy=year`],
    ["impossible date", `merchantId=${MERCHANT}&startDate=2026-02-30&endDate=2026-03-30&currency=USDC`],
    ["datetime without zone", `merchantId=${MERCHANT}&startDate=2026-09-01T10:00&endDate=2026-09-30&currency=USDC`],
    ["inverted range", `merchantId=${MERCHANT}&startDate=2026-09-30&endDate=2026-09-01&currency=USDC`],
    ["too many day buckets", `merchantId=${MERCHANT}&startDate=2024-01-01&endDate=2026-01-01&currency=USDC`],
  ])("rejects %s", (_label, query) => {
    expect(parseRevenueAggregateQuery(new URLSearchParams(query)).ok).toBe(false);
  });
});

describe("GET /api/v1/merchant/analytics/revenue", () => {
  it("rejects unauthenticated requests", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: null, token: null });
    const { handler, service } = makeHandler();
    const res = await call(handler, VALID);
    expect(res.writeHead).toHaveBeenCalledWith(401);
    expect(service.getRevenueAggregates).not.toHaveBeenCalled();
  });

  it("returns 400 with every validation error before touching the database", async () => {
    const { handler, ownerCheck } = makeHandler();
    const res = await call(handler, "merchantId=nope&groupBy=year");
    expect(res.writeHead).toHaveBeenCalledWith(400);
    const body = JSON.parse(String(vi.mocked(res.end).mock.calls[0][0]));
    expect(body.error.details.length).toBeGreaterThanOrEqual(4);
    expect(ownerCheck).not.toHaveBeenCalled();
  });

  it("forbids reading another merchant's revenue", async () => {
    const { handler, service } = makeHandler(false);
    const res = await call(handler, VALID);
    expect(res.writeHead).toHaveBeenCalledWith(403);
    expect(service.getRevenueAggregates).not.toHaveBeenCalled();
  });

  it("lets admins read any merchant", async () => {
    vi.mocked(getAuthenticatedUserContext).mockReturnValue({ userId: USER, email: "", roles: ["admin"], permissions: [] });
    const { handler, ownerCheck } = makeHandler(false);
    const res = await call(handler, VALID);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect(ownerCheck).not.toHaveBeenCalled();
  });

  it("returns stroop totals as exact strings", async () => {
    const { handler, service } = makeHandler();
    const res = await call(handler, VALID);
    expect(service.getRevenueAggregates).toHaveBeenCalledWith(expect.objectContaining({ currency: "USDC" }));
    expect(String(vi.mocked(res.end).mock.calls[0][0])).toContain('"9007199254740993"');
  });
});
