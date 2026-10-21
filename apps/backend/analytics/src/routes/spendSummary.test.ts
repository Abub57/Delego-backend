import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractAuth } from "../../../gateway/middleware/auth.js";
import { getSpendSummary } from "../metrics/spendSummary.js";
import { getSpendSummaryHandler } from "./spendSummary.js";

vi.mock("../../../gateway/middleware/auth.js", () => ({ extractAuth: vi.fn() }));
vi.mock("../metrics/spendSummary.js", () => ({ getSpendSummary: vi.fn() }));
// The shared error helper imports gateway-only dependencies in this workspace.
vi.mock("../../../gateway/src/errors.js", () => ({
  unauthorized: (res: ServerResponse) => { res.writeHead(401); res.end(); },
  sendApiError: (res: ServerResponse, status: number, code: string, message: string) => {
    res.writeHead(status); res.end(JSON.stringify({ error: { code, message } }));
  },
}));

async function request(query = "") {
  const req = { url: `/api/v1/analytics/spend-summary${query}`, headers: {} } as IncomingMessage;
  const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
  await getSpendSummaryHandler(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(extractAuth).mockReturnValue({ userId: "00000000-0000-0000-0000-000000000001", token: "token" });
  vi.mocked(getSpendSummary).mockResolvedValue([]);
});

describe("GET spend-summary", () => {
  it("rejects unauthenticated requests before querying", async () => {
    vi.mocked(extractAuth).mockReturnValue({ userId: null, token: null });
    const res = await request();
    expect(res.writeHead).toHaveBeenCalledWith(401);
    expect(getSpendSummary).not.toHaveBeenCalled();
  });

  it("uses the authenticated user even when a different userId is supplied", async () => {
    vi.mocked(getSpendSummary).mockResolvedValue([
      { date: "2026-01-01", category: "food", totalSpentStroops: "9007199254740993", ordersCount: 1 },
    ]);
    const res = await request("?userId=other&category=food&periodStart=2026-01-01&periodEnd=2026-02-01");
    expect(getSpendSummary).toHaveBeenCalledWith({
      userId: "00000000-0000-0000-0000-000000000001", category: "food",
      periodStart: "2026-01-01", periodEnd: "2026-02-01", granularity: "daily",
    });
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect(String(vi.mocked(res.end).mock.calls[0][0])).toContain('"9007199254740993"');
  });

  it.each([
    "?granularity=yearly", "?periodStart=2026-02-30", "?periodStart=invalid",
    "?periodStart=2026-02-01&periodEnd=2026-01-01",
    "?periodStart=2026-01-01&periodEnd=2026-01-01",
    "?periodStart=2020-01-01&periodEnd=2026-01-01", "?category=",
    `?category=${"x".repeat(65)}`,
    "?granularity=monthly&periodStart=2026-01-02&periodEnd=2026-02-01",
  ])("rejects invalid filters: %s", async (query) => {
    const res = await request(query);
    expect(res.writeHead).toHaveBeenCalledWith(400);
    expect(getSpendSummary).not.toHaveBeenCalled();
  });

  it("defaults monthly requests to the current UTC month", async () => {
    const res = await request("?granularity=monthly");
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect(getSpendSummary).toHaveBeenCalledWith(expect.objectContaining({
      granularity: "monthly", periodStart: expect.stringMatching(/-01$/), periodEnd: expect.stringMatching(/-01$/),
    }));
  });

  it("returns an empty data set for users without spend", async () => {
    const res = await request();
    expect(JSON.parse(String(vi.mocked(res.end).mock.calls[0][0])).data.rows).toEqual([]);
  });

  it("returns 500 without exposing database errors", async () => {
    vi.mocked(getSpendSummary).mockRejectedValue(new Error("private database details"));
    const res = await request();
    expect(res.writeHead).toHaveBeenCalledWith(500);
    expect(String(vi.mocked(res.end).mock.calls[0][0])).not.toContain("private database details");
  });
});
