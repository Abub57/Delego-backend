import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import type { Logger } from "@delegolabs/utils";

import {
  NoViableQuoteError,
  PathQuoteService,
  applySlippage,
  estimatePriceImpactPct,
} from "./pathQuoteService.js";
import { HorizonRequestError, PooledHorizonClient, type HorizonPathRecord, type HorizonPathsClient, type StrictReceivePathsQuery } from "./horizonClient.js";
import { StellarKeypairQuoteSigner, verifySignedQuote } from "./quoteSigner.js";
import { QuoteValidationError, formatAmount, parseAmount } from "./assets.js";
import { createPathQuoteHandler } from "./routes.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const USDC_ISSUER = Keypair.random().publicKey();
const EURC_ISSUER = Keypair.random().publicKey();
const USDC = `USDC:${USDC_ISSUER}`;
const EURC = `EURC:${EURC_ISSUER}`;
const ORACLE = Keypair.random();
const NOW = new Date("2026-10-19T12:00:00.000Z");

type SourceSpec = { asset: "XLM" | "EURC"; full: string; probe: string; path?: HorizonPathRecord["path"] };

function record(source: "XLM" | "EURC", sourceAmount: string, destAmount: string, path: HorizonPathRecord["path"] = []): HorizonPathRecord {
  return {
    source_asset_type: source === "XLM" ? "native" : "credit_alphanum4",
    ...(source === "EURC" ? { source_asset_code: "EURC", source_asset_issuer: EURC_ISSUER } : {}),
    source_amount: sourceAmount,
    destination_asset_type: "credit_alphanum4",
    destination_asset_code: "USDC",
    destination_asset_issuer: USDC_ISSUER,
    destination_amount: destAmount,
    path,
  };
}

/**
 * Mock Horizon: answers the full-amount request with `full` source amounts
 * and the probe request with `probe` amounts, as Horizon would.
 */
function mockHorizon(destinationAmount: string, sources: SourceSpec[]) {
  const calls: StrictReceivePathsQuery[] = [];
  const client: HorizonPathsClient = {
    strictReceivePaths: vi.fn(async (query: StrictReceivePathsQuery) => {
      calls.push(query);
      const isFull = query.destinationAmount === destinationAmount;
      return sources.map((s) => record(s.asset, isFull ? s.full : s.probe, query.destinationAmount, s.path));
    }),
  };
  return { client, calls };
}

function service(horizon: HorizonPathsClient, extra: Partial<ConstructorParameters<typeof PathQuoteService>[0]> = {}) {
  return new PathQuoteService({
    horizon,
    signer: new StellarKeypairQuoteSigner(ORACLE.secret(), "test-oracle"),
    now: () => NOW,
    newQuoteId: () => "quote-1",
    logger: silentLogger,
    ...extra,
  });
}

// ---------------------------------------------------------------------------

describe("amount math", () => {
  it("parses and formats 7-decimal amounts exactly", () => {
    expect(parseAmount("100")).toBe(1_000_000_000n);
    expect(parseAmount("0.0000001")).toBe(1n);
    expect(formatAmount(1_005_000_000n)).toBe("100.5000000");
    expect(() => parseAmount("1.12345678")).toThrow(QuoteValidationError);
    expect(() => parseAmount("1e3")).toThrow(QuoteValidationError);
  });

  it("applies slippage with ceiling rounding (never under-quotes sendMax)", () => {
    expect(applySlippage(parseAmount("100"), 0.5)).toBe(parseAmount("100.5"));
    expect(applySlippage(1n, 0.5)).toBe(2n);
    expect(applySlippage(parseAmount("100"), 0)).toBe(parseAmount("100"));
  });

  it("estimates price impact against the probe (spot) rate", () => {
    expect(estimatePriceImpactPct({ source: 10_200n, dest: 10_000n }, { source: 100n, dest: 100n })).toBe(2);
    expect(estimatePriceImpactPct({ source: 9_990n, dest: 10_000n }, { source: 100n, dest: 100n })).toBe(0);
  });
});

describe("PathQuoteService", () => {
  it("returns a signed quote with slippage-adjusted sourceAmountMax and 60s validity", async () => {
    // 100 USDC costs 1000 XLM; the 0.1 USDC probe costs 0.995 XLM → ~0.5% impact.
    const horizon = mockHorizon("100.0000000", [{ asset: "XLM", full: "1000.0000000", probe: "0.9950000" }]);

    const { best, rejected } = await service(horizon.client).getQuote({
      sourceAssets: ["XLM"],
      destinationAsset: USDC,
      destinationAmount: "100",
    });

    expect(best.quote).toEqual({
      sourceAsset: "XLM",
      sourceAmountMax: "1005.0000000",
      destinationAmount: "100.0000000",
      path: [],
      estimatedPriceImpactPct: 0.5,
      validUntil: "2026-10-19T12:01:00.000Z",
    });
    expect(best).toMatchObject({ quoteId: "quote-1", destinationAsset: USDC, signerPublicKey: ORACLE.publicKey() });
    expect(rejected).toEqual([]);
  });

  it("queries Horizon once for the full amount and once for the probe, with all source assets", async () => {
    const horizon = mockHorizon("100.0000000", [
      { asset: "XLM", full: "1000.0000000", probe: "0.9990000" },
      { asset: "EURC", full: "92.0000000", probe: "0.0919000" },
    ]);

    await service(horizon.client).getQuote({ sourceAssets: ["XLM", EURC], destinationAsset: USDC, destinationAmount: "100" });

    expect(horizon.calls).toHaveLength(2);
    expect(horizon.calls.map((c) => c.destinationAmount).sort()).toEqual(["0.1000000", "100.0000000"]);
    expect(horizon.calls[0].sourceAssets).toEqual(["native", EURC]);
    expect(horizon.calls[0].destinationAsset).toEqual({ type: "credit_alphanum4", code: "USDC", issuer: USDC_ISSUER });
  });

  it("honours a user-specified slippage tolerance", async () => {
    const horizon = mockHorizon("100.0000000", [{ asset: "XLM", full: "1000.0000000", probe: "0.9990000" }]);
    const { best } = await service(horizon.client).getQuote({
      sourceAssets: ["XLM"],
      destinationAsset: USDC,
      destinationAmount: "100",
      slippageTolerancePct: 1,
    });
    expect(best.quote.sourceAmountMax).toBe("1010.0000000");
  });

  it("rejects thin liquidity above the price-impact limit and falls back to another asset", async () => {
    const horizon = mockHorizon("100.0000000", [
      // 1100 XLM vs spot 0.999/0.1 → ~10% impact: rejected.
      { asset: "XLM", full: "1100.0000000", probe: "0.9990000" },
      { asset: "EURC", full: "92.1000000", probe: "0.0920000" },
    ]);

    const { best, rejected } = await service(horizon.client).getQuote({
      sourceAssets: ["XLM", EURC],
      destinationAsset: USDC,
      destinationAmount: "100",
    });

    expect(best.quote.sourceAsset).toBe(EURC);
    expect(best.quote.estimatedPriceImpactPct).toBeLessThanOrEqual(2.5);
    expect(rejected).toEqual([{ sourceAsset: "XLM", reason: expect.stringMatching(/price impact 10\.11% exceeds 2\.5%/) }]);
  });

  it("prefers the lowest price impact and breaks ties by the caller's order", async () => {
    const equal = mockHorizon("100.0000000", [
      { asset: "XLM", full: "1000.0000000", probe: "1.0000000" },
      { asset: "EURC", full: "92.0000000", probe: "0.0920000" },
    ]);
    const tie = await service(equal.client).getQuote({ sourceAssets: [EURC, "XLM"], destinationAsset: USDC, destinationAmount: "100" });
    expect(tie.best.quote.sourceAsset).toBe(EURC);

    const better = mockHorizon("100.0000000", [
      { asset: "XLM", full: "1000.0000000", probe: "1.0000000" },
      { asset: "EURC", full: "93.0000000", probe: "0.0920000" },
    ]);
    const pick = await service(better.client).getQuote({ sourceAssets: [EURC, "XLM"], destinationAsset: USDC, destinationAmount: "100" });
    expect(pick.best.quote.sourceAsset).toBe("XLM");
  });

  it("maps intermediate hops to canonical asset strings", async () => {
    const horizon = mockHorizon("100.0000000", [
      {
        asset: "EURC",
        full: "92.0000000",
        probe: "0.0920000",
        path: [{ asset_type: "native" }, { asset_type: "credit_alphanum4", asset_code: "BTC", asset_issuer: USDC_ISSUER }],
      },
    ]);
    const { best } = await service(horizon.client).getQuote({ sourceAssets: [EURC], destinationAsset: USDC, destinationAmount: "100" });
    expect(best.quote.path).toEqual(["XLM", `BTC:${USDC_ISSUER}`]);
  });

  it("throws NoViableQuoteError with per-asset reasons when Horizon finds no path", async () => {
    const empty: HorizonPathsClient = { strictReceivePaths: async () => [] };
    const err = await service(empty)
      .getQuote({ sourceAssets: ["XLM", EURC], destinationAsset: USDC, destinationAmount: "100" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoViableQuoteError);
    expect((err as NoViableQuoteError).rejected.map((r) => r.sourceAsset)).toEqual(["XLM", EURC]);
  });

  it("ignores Horizon records for a different destination asset", async () => {
    const wrongDest: HorizonPathsClient = {
      strictReceivePaths: async (q) => [{ ...record("XLM", "1.0000000", q.destinationAmount), destination_asset_code: "USDT" }],
    };
    await expect(
      service(wrongDest).getQuote({ sourceAssets: ["XLM"], destinationAsset: USDC, destinationAmount: "100" })
    ).rejects.toBeInstanceOf(NoViableQuoteError);
  });

  it.each([
    ["no source assets", { sourceAssets: [], destinationAsset: USDC, destinationAmount: "1" }],
    ["too many source assets", { sourceAssets: Array.from({ length: 16 }, () => "XLM"), destinationAsset: USDC, destinationAmount: "1" }],
    ["invalid issuer", { sourceAssets: ["EURC:GBAD"], destinationAsset: USDC, destinationAmount: "1" }],
    ["destination listed as source", { sourceAssets: [USDC], destinationAsset: USDC, destinationAmount: "1" }],
    ["zero amount", { sourceAssets: ["XLM"], destinationAsset: USDC, destinationAmount: "0" }],
    ["8 decimal places", { sourceAssets: ["XLM"], destinationAsset: USDC, destinationAmount: "1.00000001" }],
    ["slippage above 5%", { sourceAssets: ["XLM"], destinationAsset: USDC, destinationAmount: "1", slippageTolerancePct: 6 }],
    ["negative slippage", { sourceAssets: ["XLM"], destinationAsset: USDC, destinationAmount: "1", slippageTolerancePct: -1 }],
  ])("rejects %s before calling Horizon", async (_label, request) => {
    const horizon = mockHorizon("1.0000000", []);
    await expect(service(horizon.client).getQuote(request)).rejects.toBeInstanceOf(QuoteValidationError);
    expect(horizon.calls).toHaveLength(0);
  });
});

describe("quote signature", () => {
  async function issue() {
    const horizon = mockHorizon("100.0000000", [{ asset: "XLM", full: "1000.0000000", probe: "0.9990000" }]);
    return (await service(horizon.client).getQuote({ sourceAssets: ["XLM"], destinationAsset: USDC, destinationAmount: "100" })).best;
  }

  it("verifies against the configured oracle key within the validity window", async () => {
    const signed = await issue();
    expect(verifySignedQuote(signed, ORACLE.publicKey(), new Date("2026-10-19T12:00:59Z"))).toEqual({ valid: true });
  });

  it("expires after 60 seconds", async () => {
    const signed = await issue();
    expect(verifySignedQuote(signed, ORACLE.publicKey(), new Date("2026-10-19T12:01:01Z"))).toEqual({
      valid: false,
      reason: "quote expired",
    });
  });

  it("detects a tampered amount even if signedPayload is left intact", async () => {
    const signed = await issue();
    const tampered = { ...signed, quote: { ...signed.quote, sourceAmountMax: "1.0000000" } };
    expect(verifySignedQuote(tampered, ORACLE.publicKey(), NOW)).toMatchObject({ valid: false });
  });

  it("rejects a quote self-signed with a different key", async () => {
    const signed = await issue();
    expect(verifySignedQuote(signed, Keypair.random().publicKey(), NOW)).toEqual({ valid: false, reason: "invalid signature" });
  });
});

// ---------------------------------------------------------------------------

describe("PooledHorizonClient", () => {
  let server: http.Server | null = null;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function startHorizon(handler: http.RequestListener): Promise<string> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("builds the strict-receive query and reuses a pooled connection", async () => {
    const urls: string[] = [];
    const sockets = new Set<unknown>();
    const url = await startHorizon((req, res) => {
      urls.push(req.url ?? "");
      sockets.add(req.socket);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ _embedded: { records: [record("XLM", "10.0000000", "1.0000000")] } }));
    });
    const client = new PooledHorizonClient(url, { maxSockets: 1 });
    const query = {
      sourceAssets: ["native", EURC],
      destinationAsset: { type: "credit_alphanum4", code: "USDC", issuer: USDC_ISSUER },
    };

    const records = await client.strictReceivePaths({ ...query, destinationAmount: "1.0000000" });
    await client.strictReceivePaths({ ...query, destinationAmount: "2.0000000" });
    client.close();

    expect(records).toHaveLength(1);
    const params = new URL(urls[0], url).searchParams;
    expect(new URL(urls[0], url).pathname).toBe("/paths/strict-receive");
    expect(params.get("source_assets")).toBe(`native,${EURC}`);
    expect(params.get("destination_asset_code")).toBe("USDC");
    expect(params.get("destination_asset_issuer")).toBe(USDC_ISSUER);
    expect(params.get("destination_amount")).toBe("1.0000000");
    expect(sockets.size).toBe(1);
  });

  it("coalesces identical concurrent requests into one upstream call", async () => {
    let hits = 0;
    const url = await startHorizon((_req, res) => {
      hits++;
      setTimeout(() => res.end(JSON.stringify({ _embedded: { records: [] } })), 20);
    });
    const client = new PooledHorizonClient(url);
    const query = { sourceAssets: ["native"], destinationAsset: { type: "native" }, destinationAmount: "1.0000000" };

    await Promise.all([client.strictReceivePaths(query), client.strictReceivePaths(query)]);
    client.close();

    expect(hits).toBe(1);
  });

  it("surfaces Horizon HTTP errors with their status", async () => {
    const url = await startHorizon((_req, res) => {
      res.writeHead(503);
      res.end("{}");
    });
    const client = new PooledHorizonClient(url);
    const err = await client
      .strictReceivePaths({ sourceAssets: ["native"], destinationAsset: { type: "native" }, destinationAmount: "1.0000000" })
      .catch((e: unknown) => e);
    client.close();
    expect(err).toBeInstanceOf(HorizonRequestError);
    expect((err as HorizonRequestError).status).toBe(503);
  });
});

describe("POST /api/v1/payments/path-quotes", () => {
  function call(body: string, getQuote: () => Promise<unknown>) {
    const req = {
      headers: {},
      on(event: string, cb: (chunk?: Buffer) => void) {
        if (event === "data") cb(Buffer.from(body));
        if (event === "end") cb();
        return this;
      },
    } as unknown as IncomingMessage;
    const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    const handler = createPathQuoteHandler(() => ({ getQuote: getQuote as never }));
    return { res, run: () => handler(req, res) };
  }

  it.each<[string, () => Promise<unknown>, number]>([
    ["validation error", async () => Promise.reject(new QuoteValidationError("bad")), 400],
    ["no viable path", async () => Promise.reject(new NoViableQuoteError([])), 422],
    ["Horizon outage", async () => Promise.reject(new HorizonRequestError("down", 503)), 502],
    ["success", async () => ({ best: {}, rejected: [] }), 200],
  ])("maps %s to HTTP %i", async (_label, getQuote, status) => {
    const { res, run } = call("{}", getQuote);
    await run();
    expect(res.writeHead).toHaveBeenCalledWith(status, expect.anything());
  });

  it("returns 503 when no oracle key is configured", async () => {
    const req = { headers: {}, on() { return this; } } as unknown as IncomingMessage;
    const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    await createPathQuoteHandler(() => null)(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.anything());
  });
});
