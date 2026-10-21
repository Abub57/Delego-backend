import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerFeeEstimatorRoutes } from "../routes.js";
import { DynamicFeeEstimator } from "../dynamicFeeEstimator.js";
import type { DynamicFeeRecommendation } from "@delegolabs/types";

describe("Fee Estimator Routes", () => {
  const routes = registerFeeEstimatorRoutes();

  const mockRecommendation: DynamicFeeRecommendation = {
    lowStroops: 100,
    standardStroops: 250,
    priorityStroops: 600,
    currentCongestionLevel: "medium",
    baseFee: 100,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should register GET /api/v1/fee/recommendation route", () => {
    const route = routes.find(
      (r) => r.method === "GET" && r.pattern.test("/api/v1/fee/recommendation"),
    );
    expect(route).toBeDefined();
  });

  it("should register POST /api/v1/fee/refresh route", () => {
    const route = routes.find(
      (r) => r.method === "POST" && r.pattern.test("/api/v1/fee/refresh"),
    );
    expect(route).toBeDefined();
  });

  it("should register GET /api/v1/fee/metrics route", () => {
    const route = routes.find(
      (r) => r.method === "GET" && r.pattern.test("/api/v1/fee/metrics"),
    );
    expect(route).toBeDefined();
  });

  it("should handle GET /api/v1/fee/recommendation and return recommendation data", async () => {
    const route = routes.find(
      (r) => r.method === "GET" && r.pattern.test("/api/v1/fee/recommendation"),
    )!;

    vi.spyOn(DynamicFeeEstimator.prototype, "getFeeRecommendation").mockResolvedValue(mockRecommendation);

    let responseData: any = null;
    let statusCode: number = 0;

    const mockReq = {
      url: "/api/v1/fee/recommendation",
      headers: { host: "localhost:3012" },
    };

    const mockRes = {
      setHeader: vi.fn(),
      writeHead: vi.fn((status: number) => {
        statusCode = status;
      }),
      end: vi.fn((body: string) => {
        responseData = JSON.parse(body);
      }),
      writableEnded: false,
    };

    await route.handler(mockReq as any, mockRes as any, {});

    expect(statusCode).toBe(200);
    expect(responseData.data).toEqual(mockRecommendation);
    expect(responseData.error).toBeNull();
  });

  it("should handle GET /api/v1/fee/recommendation with urgency parameter", async () => {
    const route = routes.find(
      (r) => r.method === "GET" && r.pattern.test("/api/v1/fee/recommendation"),
    )!;

    vi.spyOn(DynamicFeeEstimator.prototype, "getFeeRecommendation").mockResolvedValue(mockRecommendation);
    vi.spyOn(DynamicFeeEstimator.prototype, "getFeeForUrgency").mockResolvedValue("600");

    let responseData: any = null;
    let statusCode: number = 0;

    const mockReq = {
      url: "/api/v1/fee/recommendation?urgency=priority",
      headers: { host: "localhost:3012" },
    };

    const mockRes = {
      setHeader: vi.fn(),
      writeHead: vi.fn((status: number) => {
        statusCode = status;
      }),
      end: vi.fn((body: string) => {
        responseData = JSON.parse(body);
      }),
      writableEnded: false,
    };

    await route.handler(mockReq as any, mockRes as any, {});

    expect(statusCode).toBe(200);
    expect(responseData.data.selectedUrgency).toBe("priority");
    expect(responseData.data.feeStroops).toBe("600");
  });

  it("should handle POST /api/v1/fee/refresh", async () => {
    const route = routes.find(
      (r) => r.method === "POST" && r.pattern.test("/api/v1/fee/refresh"),
    )!;

    vi.spyOn(DynamicFeeEstimator.prototype, "refreshFeeStats").mockResolvedValue(mockRecommendation);

    let responseData: any = null;
    let statusCode: number = 0;

    const mockReq = {
      url: "/api/v1/fee/refresh",
      headers: { host: "localhost:3012" },
    };

    const mockRes = {
      setHeader: vi.fn(),
      writeHead: vi.fn((status: number) => {
        statusCode = status;
      }),
      end: vi.fn((body: string) => {
        responseData = JSON.parse(body);
      }),
      writableEnded: false,
    };

    await route.handler(mockReq as any, mockRes as any, {});

    expect(statusCode).toBe(200);
    expect(responseData.data.message).toBe("Fee statistics refreshed successfully");
    expect(responseData.data.recommendation).toEqual(mockRecommendation);
  });
});
