import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createDiscountHandler,
  CreateDiscountSchema,
  isAuthorizedRole,
  CreateDiscountDTO,
} from "./discounts.js";

const { findByPk, findOne, create } = vi.hoisted(() => ({
  findByPk: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
}));

const { extractAuthMock, getAuthenticatedUserContextMock } = vi.hoisted(() => ({
  extractAuthMock: vi.fn(),
  getAuthenticatedUserContextMock: vi.fn(),
}));

vi.mock("../../middleware/auth.js", () => ({
  extractAuth: (req: IncomingMessage) => extractAuthMock(req),
  getAuthenticatedUserContext: (req: IncomingMessage) => getAuthenticatedUserContextMock(req),
}));

vi.mock("../models/index.js", () => ({
  Merchant: {
    findByPk,
    findOne,
  },
  Discount: {
    findOne,
    create,
  },
}));

let requestBody: any = {};
vi.mock("../request.js", () => ({
  readJsonBody: vi.fn(async () => requestBody),
  InvalidJsonError: class InvalidJsonError extends Error {},
  BodyTooLargeError: class BodyTooLargeError extends Error {},
}));

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
  headersSent: boolean;
  headers: Record<string, string>;
  setHeader(name: string, value: string | number): void;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
};

function createResponse(): MockResponse {
  return {
    statusCode: 0,
    body: "",
    headersSent: false,
    headers: {},
    setHeader(name: string, value: string | number) {
      this.headers[name.toLowerCase()] = String(value);
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      this.headersSent = true;
      if (headers) {
        Object.assign(this.headers, headers);
      }
    },
    end(body?: string) {
      if (body) this.body = body;
    },
  } as MockResponse;
}

function createRequest(): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { authorization: "Bearer valid-token" };
  return req;
}

describe("POST /api/v1/merchants/:merchantId/discounts", () => {
  const mockMerchant = {
    id: "merchant-123",
    ownerUserId: "user-owner-1",
    storeName: "Acme Store",
  };

  const validPayload: CreateDiscountDTO = {
    code: "SUMMER2026",
    discountType: "percentage",
    discountValue: "20",
    minOrderStroops: "10000000",
    maxUses: 100,
    validFrom: "2026-06-01T00:00:00.000Z",
    validUntil: "2026-08-31T23:59:59.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    requestBody = { ...validPayload };

    extractAuthMock.mockReturnValue({ userId: "user-owner-1", token: "valid-token" });
    getAuthenticatedUserContextMock.mockReturnValue({
      userId: "user-owner-1",
      email: "owner@acme.com",
      roles: ["merchant:owner"],
      permissions: ["catalog:write"],
    });

    findByPk.mockResolvedValue(mockMerchant);
    findOne.mockResolvedValue(null); // default: no existing duplicate discount
    create.mockImplementation(async (data: any) => ({
      id: "discount-uuid-1",
      usesCount: 0,
      isActive: true,
      createdAt: new Date("2026-05-01T12:00:00Z"),
      updatedAt: new Date("2026-05-01T12:00:00Z"),
      ...data,
    }));
  });

  describe("Zod Payload Validation", () => {
    it("accepts valid alphanumeric uppercase promo codes", () => {
      const validCodes = ["SUMMER2026", "VIP100", "A1B2C3", "DISCOUNT"];
      for (const code of validCodes) {
        const result = CreateDiscountSchema.safeParse({ ...validPayload, code });
        expect(result.success).toBe(true);
      }
    });

    it("rejects promo codes with lowercase characters", async () => {
      requestBody = { ...validPayload, code: "summer2026" };
      const res = createResponse();

      await createDiscountHandler(createRequest(), res, { merchantId: "merchant-123" });

      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(json.error.details)).toContain("alphanumeric uppercase");
      expect(create).not.toHaveBeenCalled();
    });

    it("rejects promo codes with special characters or spaces", async () => {
      const invalidCodes = ["SUMMER-26", "SAVE 20", "CODE#1", "SALE_50"];
      for (const code of invalidCodes) {
        const result = CreateDiscountSchema.safeParse({ ...validPayload, code });
        expect(result.success).toBe(false);
      }
    });

    it("rejects percentage values outside 1-100", async () => {
      const invalidPercentages = ["0", "101", "-5", "abc"];
      for (const discountValue of invalidPercentages) {
        const result = CreateDiscountSchema.safeParse({
          ...validPayload,
          discountType: "percentage",
          discountValue,
        });
        expect(result.success).toBe(false);
      }
    });

    it("accepts valid fixed_stroops discount values", async () => {
      const result = CreateDiscountSchema.safeParse({
        ...validPayload,
        discountType: "fixed_stroops",
        discountValue: "50000000",
      });
      expect(result.success).toBe(true);
    });

    it("rejects when validUntil is before validFrom", async () => {
      requestBody = {
        ...validPayload,
        validFrom: "2026-10-01T00:00:00.000Z",
        validUntil: "2026-09-01T00:00:00.000Z",
      };
      const res = createResponse();

      await createDiscountHandler(createRequest(), res, { merchantId: "merchant-123" });

      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(json.error.details)).toContain("validUntil must be after validFrom");
      expect(create).not.toHaveBeenCalled();
    });

    it("rejects non-positive maxUses", () => {
      const result = CreateDiscountSchema.safeParse({
        ...validPayload,
        maxUses: 0,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("Authentication & Role Authorization", () => {
    it("returns 401 when request is unauthenticated", async () => {
      extractAuthMock.mockReturnValue({ userId: null, token: null });
      const res = createResponse();

      await createDiscountHandler(createRequest(), res, { merchantId: "merchant-123" });

      expect(res.statusCode).toBe(401);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe("UNAUTHORIZED");
      expect(create).not.toHaveBeenCalled();
    });

    it("returns 403 when user has unauthorized role (e.g. regular user or buyer)", async () => {
      extractAuthMock.mockReturnValue({ userId: "customer-999", token: "user-token" });
      getAuthenticatedUserContextMock.mockReturnValue({
        userId: "customer-999",
        roles: ["user"],
        permissions: [],
      });
      // customer-999 is not owner of mockMerchant (owner is user-owner-1)
      const res = createResponse();

      await createDiscountHandler(createRequest(), res, { merchantId: "merchant-123" });

      expect(res.statusCode).toBe(403);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe("FORBIDDEN");
      expect(json.error.message).toContain("Only merchant owners or authorized staff");
      expect(create).not.toHaveBeenCalled();
    });

    it("returns 403 when non-admin staff tries to manage another merchant store they don't own", async () => {
      extractAuthMock.mockReturnValue({ userId: "staff-2", token: "staff-token" });
      getAuthenticatedUserContextMock.mockReturnValue({
        userId: "staff-2",
        roles: ["user"], // not staff or owner
        permissions: [],
      });
      const res = createResponse();

      await createDiscountHandler(createRequest(), res, { merchantId: "merchant-123" });

      expect(res.statusCode).toBe(403);
      expect(create).not.toHaveBeenCalled();
    });

    it("allows authenticated merchant owner to create discount", async () => {
      extractAuthMock.mockReturnValue({ userId: "user-owner-1", token: "owner-token" });
      getAuthenticatedUserContextMock.mockReturnValue({
        userId: "user-owner-1",
        roles: ["merchant:owner"],
        permissions: [],
      });
      const res = createResponse();

      await createDiscountHandler(createRequest(), res, { merchantId: "merchant-123" });

      expect(res.statusCode).toBe(201);
      expect(create).toHaveBeenCalledOnce();
    });

    it("allows authorized staff member with manager role", async () => {
      extractAuthMock.mockReturnValue({ userId: "staff-manager-1", token: "staff-token" });
      getAuthenticatedUserContextMock.mockReturnValue({
        userId: "staff-manager-1",
        roles: ["merchant:manager"],
        permissions: ["catalog:write"],
      });
      // Store owned by user-owner-1, but caller is merchant:manager
      const res = createResponse();

      await createDiscountHandler(createRequest(), res, { merchantId: "merchant-123" });

      expect(res.statusCode).toBe(201);
      expect(create).toHaveBeenCalledOnce();
    });

    it("allows platform admin to create discounts for any merchant", async () => {
      extractAuthMock.mockReturnValue({ userId: "admin-super", token: "admin-token" });
      getAuthenticatedUserContextMock.mockReturnValue({
        userId: "admin-super",
        roles: ["admin"],
        permissions: ["*"],
      });
      const res = createResponse();

      await createDiscountHandler(createRequest(), res, { merchantId: "merchant-123" });

      expect(res.statusCode).toBe(201);
      expect(create).toHaveBeenCalledOnce();
    });

    it("evaluates isAuthorizedRole correctly for various role combinations", () => {
      expect(isAuthorizedRole(["admin"])).toBe(true);
      expect(isAuthorizedRole(["merchant:owner"])).toBe(true);
      expect(isAuthorizedRole(["owner"])).toBe(true);
      expect(isAuthorizedRole(["merchant:admin"])).toBe(true);
      expect(isAuthorizedRole(["merchant:manager"])).toBe(true);
      expect(isAuthorizedRole(["merchant:staff"])).toBe(true);
      expect(isAuthorizedRole(["staff"])).toBe(true);
      expect(isAuthorizedRole([], ["catalog:write"])).toBe(true);
      expect(isAuthorizedRole([], ["*"])).toBe(true);
      expect(isAuthorizedRole(["user"])).toBe(false);
      expect(isAuthorizedRole(["merchant:operator"])).toBe(false);
      expect(isAuthorizedRole(["merchant:finance"])).toBe(false);
      expect(isAuthorizedRole([])).toBe(false);
    });
  });

  describe("Duplicate Promo Codes (HTTP 409)", () => {
    it("rejects duplicate code for the same merchant with HTTP 409", async () => {
      // Mock existing discount with same code
      findOne.mockResolvedValue({
        id: "existing-discount-id",
        merchantId: "merchant-123",
        code: "SUMMER2026",
      });

      const res = createResponse();
      await createDiscountHandler(createRequest(), res, { merchantId: "merchant-123" });

      expect(res.statusCode).toBe(409);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe("DUPLICATE_DISCOUNT_CODE");
      expect(json.error.message).toContain("already exists for this merchant");
      expect(create).not.toHaveBeenCalled();
    });

    it("handles concurrent race condition duplicate with HTTP 409 on unique violation", async () => {
      findOne.mockResolvedValue(null);
      const uniqueViolationError: any = new Error("Validation error");
      uniqueViolationError.name = "SequelizeUniqueConstraintError";
      uniqueViolationError.errors = [{ type: "unique violation" }];
      create.mockRejectedValue(uniqueViolationError);

      const res = createResponse();
      await createDiscountHandler(createRequest(), res, { merchantId: "merchant-123" });

      expect(res.statusCode).toBe(409);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe("DUPLICATE_DISCOUNT_CODE");
    });
  });

  describe("Successful Creation & Response Structure", () => {
    it("creates discount and returns HTTP 201 with properly formatted data", async () => {
      const res = createResponse();
      await createDiscountHandler(createRequest(), res, { merchantId: "merchant-123" });

      expect(res.statusCode).toBe(201);
      const json = JSON.parse(res.body);
      expect(json.error).toBeNull();
      expect(json.data).toMatchObject({
        id: "discount-uuid-1",
        merchantId: "merchant-123",
        code: "SUMMER2026",
        discountType: "percentage",
        discountValue: "20",
        minOrderStroops: "10000000",
        maxUses: 100,
        usesCount: 0,
        isActive: true,
      });
      expect(json.data.validFrom).toBe("2026-06-01T00:00:00.000Z");
      expect(json.data.validUntil).toBe("2026-08-31T23:59:59.000Z");
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          merchantId: "merchant-123",
          code: "SUMMER2026",
          discountType: "percentage",
          discountValue: "20",
          minOrderStroops: "10000000",
          maxUses: 100,
          isActive: true,
        }),
      );
    });

    it("resolves merchant from authenticated user when merchantId param is omitted", async () => {
      findByPk.mockResolvedValue(null);
      // findOne for merchant finds the user's merchant
      findOne
        .mockResolvedValueOnce(mockMerchant) // for merchant lookup
        .mockResolvedValueOnce(null); // for discount duplicate lookup

      const res = createResponse();
      await createDiscountHandler(createRequest(), res); // no params

      expect(res.statusCode).toBe(201);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          merchantId: "merchant-123",
          code: "SUMMER2026",
        }),
      );
    });
  });
});
