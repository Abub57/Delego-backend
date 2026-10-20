import Redis from "ioredis-mock";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FiatRateOracle } from "./fiatRateOracle.js";
import {
  getOracleRatesHandler,
  _setFiatRateOracleForTesting,
} from "./routes.js";

function makeRes() {
  const res: any = {
    statusCode: 0,
    body: "",
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(chunk?: string) {
      if (chunk) this.body = chunk;
    },
  };
  return res;
}

function makeReq(url: string) {
  return { url, headers: { host: "localhost" } } as any;
}

describe("#528 GET /api/v1/oracle/rates", () => {
  let redis: InstanceType<typeof Redis>;

  beforeEach(async () => {
    redis = new Redis();
    await redis.flushall();
    const oracle = new FiatRateOracle({
      redis,
      config: {
        coingeckoBaseUrl: "https://coingecko.test/api/v3",
        horizonBaseUrl: "https://horizon.test",
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("coingecko")) {
            return new Response(JSON.stringify({ stellar: { usd: 0.42 }, "usd-coin": { usd: 1 } }), {
              status: 200,
            });
          }
          return new Response(JSON.stringify({ bids: [], asks: [] }), { status: 200 });
        }) as typeof fetch,
      },
    });
    _setFiatRateOracleForTesting(oracle);
  });

  afterEach(() => {
    _setFiatRateOracleForTesting(null);
  });

  it("returns cached rates as a list", async () => {
    const res = makeRes();
    await getOracleRatesHandler(makeReq("/api/v1/oracle/rates?refresh=true&currency=USD"), res as any, {});

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.error).toBeNull();
    expect(body.data.items.length).toBeGreaterThan(0);
    expect(body.data.cacheKey).toBe("oracle:fiat_rates");
    expect(body.data.ttlSeconds).toBe(300);
  });

  it("resolves a single requested pair on demand when the cache is cold", async () => {
    const res = makeRes();
    await getOracleRatesHandler(makeReq("/api/v1/oracle/rates?asset=XLM&currency=USD"), res as any, {});

    const body = JSON.parse(res.body);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({ assetCode: "XLM", fiatCurrency: "USD" });
  });

  it("rejects an unsupported fiat currency", async () => {
    const res = makeRes();
    await getOracleRatesHandler(makeReq("/api/v1/oracle/rates?currency=JPY"), res as any, {});

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});
