/**
 * Unit tests for TimescaleDB Continuous Aggregates & Merchant Analytics (Issue #377)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MerchantAnalyticsService } from "../services/merchantAnalyticsService.js";
import { getMerchantSalesHandler } from "../routes/analyticsRoutes.js";
import { sequelize } from "../db.js";
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

vi.mock("../../../gateway/middleware/auth.js", () => ({
  extractAuth: vi.fn().mockReturnValue({ userId: "merchant_user_1", token: "valid_token" }),
}));

vi.mock("../db.js", () => ({
  sequelize: {
    query: vi.fn(),
  },
}));

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
};

function createMockReq(headers: Record<string, string> = {}, url = "/api/v1/analytics/merchants/m_123/sales"): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json", ...headers };
  req.url = url;
  process.nextTick(() => {
    req.emit("data", Buffer.from(""));
    req.emit("end");
  });
  return req;
}

function createMockRes(): MockResponse {
  const res = {
    statusCode: 200,
    body: "",
    writeHead(status: number) {
      this.statusCode = status;
    },
    setHeader() {},
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  };
  return res as unknown as MockResponse;
}

describe("MerchantAnalyticsService (Issue #377)", () => {
  let service: MerchantAnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new MerchantAnalyticsService();
  });

  it("queries 1-hour continuous aggregate view by default", async () => {
    const mockRows = [
      {
        bucket: new Date("2026-09-28T10:00:00Z"),
        merchantId: "m_1",
        volume: "1500.50",
        orderCount: 5,
        avgOrderValue: "300.10",
      },
      {
        bucket: new Date("2026-09-28T11:00:00Z"),
        merchantId: "m_1",
        volume: "2400.00",
        orderCount: 8,
        avgOrderValue: "300.00",
      },
    ];

    vi.mocked(sequelize.query).mockResolvedValue(mockRows as any);

    const result = await service.getMerchantSales({
      merchantId: "m_1",
      bucketInterval: "1h",
    });

    expect(result.merchantId).toBe("m_1");
    expect(result.interval).toBe("1h");
    expect(result.aggregates.length).toBe(2);
    expect(result.totalVolume).toBe("3900.50");
    expect(result.totalOrders).toBe(13);

    const queryCall = vi.mocked(sequelize.query).mock.calls[0][0] as string;
    expect(queryCall).toContain("merchant_hourly_sales");
  });

  it("queries 1-minute continuous aggregate view when interval is 1m", async () => {
    vi.mocked(sequelize.query).mockResolvedValue([] as any);

    const result = await service.getMerchantSales({
      merchantId: "m_2",
      bucketInterval: "1m",
    });

    expect(result.interval).toBe("1m");
    const queryCall = vi.mocked(sequelize.query).mock.calls[0][0] as string;
    expect(queryCall).toContain("merchant_minute_sales");
  });

  it("queries 1-day continuous aggregate view when interval is 1d", async () => {
    vi.mocked(sequelize.query).mockResolvedValue([] as any);

    const result = await service.getMerchantSales({
      merchantId: "m_3",
      bucketInterval: "1d",
    });

    expect(result.interval).toBe("1d");
    const queryCall = vi.mocked(sequelize.query).mock.calls[0][0] as string;
    expect(queryCall).toContain("merchant_daily_sales");
  });

  it("handles database errors gracefully and returns empty aggregate summary", async () => {
    vi.mocked(sequelize.query).mockRejectedValue(new Error("Database connection lost"));

    const result = await service.getMerchantSales({
      merchantId: "m_error",
    });

    expect(result.aggregates).toEqual([]);
    expect(result.totalVolume).toBe("0.00");
    expect(result.totalOrders).toBe(0);
  });
});

describe("GET /api/v1/analytics/merchants/:merchantId/sales HTTP route (Issue #377)", () => {
  it("returns 200 with merchant sales metrics", async () => {
    const mockRows = [
      {
        bucket: "2026-09-28T00:00:00.000Z",
        merchantId: "m_test",
        volume: "500.00",
        orderCount: 2,
        avgOrderValue: "250.00",
      },
    ];
    vi.mocked(sequelize.query).mockResolvedValue(mockRows as any);

    const req = createMockReq({}, "/api/v1/analytics/merchants/m_test/sales?interval=1h");
    const res = createMockRes();

    await getMerchantSalesHandler(req, res, { merchantId: "m_test" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.merchantId).toBe("m_test");
    expect(body.data.interval).toBe("1h");
    expect(body.data.totalVolume).toBe("500.00");
    expect(body.data.totalOrders).toBe(2);
  });

  it("returns 400 if merchantId parameter is missing", async () => {
    const req = createMockReq({}, "/api/v1/analytics/merchants//sales");
    const res = createMockRes();

    await getMerchantSalesHandler(req, res, { merchantId: "" });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});
