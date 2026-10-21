/**
 * Unit tests for #383 — granular merchant-team permission middleware.
 *
 * Covers the claims→permission resolution, the 401/403 rejection paths of
 * `requirePermission()`, and the allow/reject paths through the
 * `guardPermission()` route adapter.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("./auth.js", () => ({
  extractAuth: vi.fn(),
  getAuthenticatedUserContext: vi.fn(),
}));

import { extractAuth, getAuthenticatedUserContext } from "./auth.js";
import { requirePermission, guardPermission } from "./requirePermission.js";
import {
  MERCHANT_TEAM_PERMISSIONS,
  hasMerchantTeamPermission,
  isMerchantTeamPermission,
  resolveMerchantTeamPermissions,
} from "../src/auth/permissions.js";

const mockedExtractAuth = vi.mocked(extractAuth);
const mockedGetAuthenticatedUserContext = vi.mocked(getAuthenticatedUserContext);

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
};

function createMockReq(): IncomingMessage {
  return {
    url: "/api/v1/storage/presigned-url",
    method: "POST",
    headers: {},
  } as unknown as IncomingMessage;
}

function createMockRes(): MockResponse {
  const res = {
    statusCode: 0,
    body: "",
    setHeader() {},
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  };
  return res as unknown as MockResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveMerchantTeamPermissions", () => {
  it("grants the full permission set to merchant owners and admins", () => {
    expect(resolveMerchantTeamPermissions({ roles: ["merchant:owner"] })).toEqual([
      ...MERCHANT_TEAM_PERMISSIONS,
    ]);
    expect(resolveMerchantTeamPermissions({ roles: ["merchant:admin"] })).toEqual([
      ...MERCHANT_TEAM_PERMISSIONS,
    ]);
    expect(resolveMerchantTeamPermissions({ roles: ["admin"] })).toEqual([
      ...MERCHANT_TEAM_PERMISSIONS,
    ]);
  });

  it("maps granular merchant roles to their permissions", () => {
    expect(resolveMerchantTeamPermissions({ roles: ["merchant:operator"] })).toEqual([
      "orders:manage",
    ]);
    expect(resolveMerchantTeamPermissions({ roles: ["merchant:dispute"] })).toEqual([
      "disputes:resolve",
    ]);
    expect(resolveMerchantTeamPermissions({ roles: ["merchant:finance"] })).toEqual([
      "settlement:view",
    ]);
  });

  it("ignores unknown roles and absent claims", () => {
    expect(resolveMerchantTeamPermissions({ roles: ["user"] })).toEqual([]);
    expect(resolveMerchantTeamPermissions(undefined)).toEqual([]);
  });

  it("accepts explicit permission claims and filters invalid values", () => {
    expect(
      resolveMerchantTeamPermissions({ permissions: ["catalog:write", "not:a:permission"] }),
    ).toEqual(["catalog:write"]);
  });

  it("treats the wildcard claim as every permission", () => {
    expect(resolveMerchantTeamPermissions({ permissions: ["*"] })).toEqual([
      ...MERCHANT_TEAM_PERMISSIONS,
    ]);
  });

  it("de-duplicates permissions granted by both claims and roles", () => {
    expect(
      resolveMerchantTeamPermissions({
        roles: ["merchant:operator"],
        permissions: ["orders:manage"],
      }),
    ).toEqual(["orders:manage"]);
  });
});

describe("isMerchantTeamPermission / hasMerchantTeamPermission", () => {
  it("recognises only known permission strings", () => {
    expect(isMerchantTeamPermission("catalog:write")).toBe(true);
    expect(isMerchantTeamPermission("orders:read")).toBe(false);
    expect(isMerchantTeamPermission(42)).toBe(false);
  });

  it("reports whether claims grant a specific permission", () => {
    expect(hasMerchantTeamPermission({ roles: ["merchant:manager"] }, "catalog:write")).toBe(true);
    expect(hasMerchantTeamPermission({ roles: ["merchant:manager"] }, "settlement:view")).toBe(false);
  });
});

describe("requirePermission", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    mockedExtractAuth.mockReturnValue({ userId: null, token: null });
    const middleware = requirePermission("catalog:write");
    const res = createMockRes();
    const next = vi.fn();

    await middleware(createMockReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when the JWT claims lack the permission", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "token" });
    mockedGetAuthenticatedUserContext.mockReturnValue({
      userId: "user-1",
      email: "user@example.com",
      roles: ["user"],
      permissions: [],
    });
    const middleware = requirePermission("catalog:write");
    const res = createMockRes();
    const next = vi.fn();

    await middleware(createMockReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("FORBIDDEN");
    expect(parsed.error.message).toContain("catalog:write");
  });

  it("calls next() when the claims grant the permission", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "token" });
    mockedGetAuthenticatedUserContext.mockReturnValue({
      userId: "user-1",
      email: "user@example.com",
      roles: ["merchant:manager"],
      permissions: ["catalog:write"],
    });
    const middleware = requirePermission("catalog:write");
    const res = createMockRes();
    const next = vi.fn();

    await middleware(createMockReq(), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });
});

describe("guardPermission", () => {
  it("runs the wrapped handler when the permission is granted", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "token" });
    mockedGetAuthenticatedUserContext.mockReturnValue({
      userId: "user-1",
      email: "user@example.com",
      roles: ["merchant:owner"],
      permissions: ["catalog:write"],
    });
    const handler = vi.fn();
    const guard = guardPermission("catalog:write", handler);
    const res = createMockRes();

    await guard(createMockReq(), res, {});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not run the wrapped handler when the permission is missing", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "token" });
    mockedGetAuthenticatedUserContext.mockReturnValue({
      userId: "user-1",
      email: "user@example.com",
      roles: ["merchant:finance"],
      permissions: ["settlement:view"],
    });
    const handler = vi.fn();
    const guard = guardPermission("catalog:write", handler);
    const res = createMockRes();

    await guard(createMockReq(), res, {});

    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
