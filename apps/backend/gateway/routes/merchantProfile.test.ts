import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { updateMerchantProfileHandler } from "./merchantProfile.js";

const { findByPk, query, readJsonBody } = vi.hoisted(() => ({
  findByPk: vi.fn(),
  query: vi.fn(),
  readJsonBody: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  extractAuth: vi.fn(() => ({ userId: "user-123", token: "token" })),
}));
vi.mock("../src/db.js", () => ({ sequelize: { query } }));
vi.mock("../src/models/User.js", () => ({ User: { findByPk } }));
vi.mock("../src/request.js", () => ({
  BodyTooLargeError: class BodyTooLargeError extends Error {},
  readJsonBody,
}));

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
  headersSent: boolean;
  setHeader(name: string, value: string | number): void;
  writeHead(status: number): void;
  end(body?: string): void;
};

function createResponse(): MockResponse {
  return {
    statusCode: 0,
    body: "",
    headersSent: false,
    setHeader() {},
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(body?: string) {
      if (body) this.body = body;
    },
  } as MockResponse;
}

function createRequest(): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

describe("PATCH /api/v1/merchants/:merchantId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByPk.mockResolvedValue({ stellarAddress: "G-MERCHANT-ADDRESS" });
  });

  it.each([{ isVerified: true }, { feeBps: 0 }, { reputationScore: 99 }])(
    "rejects protected fields with 400 and never updates: %o",
    async (body) => {
      readJsonBody.mockResolvedValue(body);
      const response = createResponse();

      await updateMerchantProfileHandler(createRequest(), response, {
        merchantId: "merchant-123",
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe("VALIDATION_ERROR");
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("updates only whitelisted profile fields for the linked merchant", async () => {
    readJsonBody.mockResolvedValue({
      displayName: "Acme",
      description: "Local goods",
      supportEmail: "support@example.com",
      webhookUrl: "https://example.com/hooks/merchant",
    });
    query.mockResolvedValue([
      {
        id: "merchant-123",
        displayName: "Acme",
        description: "Local goods",
        supportEmail: "support@example.com",
        webhookUrl: "https://example.com/hooks/merchant",
      },
    ]);
    const response = createResponse();

    await updateMerchantProfileHandler(createRequest(), response, {
      merchantId: "merchant-123",
    });

    expect(response.statusCode).toBe(200);
    expect(query).toHaveBeenCalledOnce();
    const [sql, options] = query.mock.calls[0];
    expect(sql).toContain(
      "WHERE id = :merchantId AND stellar_address = :stellarAddress",
    );
    expect(sql).not.toMatch(/is_verified|fee_bps|reputation_score/i);
    expect(options.replacements).toMatchObject({
      merchantId: "merchant-123",
      stellarAddress: "G-MERCHANT-ADDRESS",
      displayName: "Acme",
      description: "Local goods",
      supportEmail: "support@example.com",
      webhookUrl: "https://example.com/hooks/merchant",
    });
  });
});
