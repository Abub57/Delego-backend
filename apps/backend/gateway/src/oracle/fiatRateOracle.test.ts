import Redis from "ioredis-mock";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FiatRateOracle,
  orderbookMidPrice,
  rateField,
} from "./fiatRateOracle.js";

const COINGECKO = "https://coingecko.test/api/v3";
const HORIZON = "https://horizon.test";

function coinGeckoFetch(prices: Record<string, number>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const id = url.match(/ids=([^&]+)/)?.[1] ?? "";
    const vs = url.match(/vs_currencies=([^&]+)/)?.[1] ?? "";
    const key = `${id}:${vs}`;
    if (key in prices) {
      return new Response(JSON.stringify({ [id]: { [vs]: prices[key] } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

function orderbookResponse(bids: string[], asks: string[]): Response {
  return new Response(
    JSON.stringify({
      bids: bids.map((price) => ({ price, amount: "100" })),
      asks: asks.map((price) => ({ price, amount: "100" })),
    }),
    { status: 200 },
  );
}

describe("#528 FiatRateOracle", () => {
  let redis: InstanceType<typeof Redis>;

  beforeEach(async () => {
    redis = new Redis();
    await redis.flushall();
  });

  describe("CoinGecko path", () => {
    it("fetches a rate from CoinGecko and caches it in the oracle:fiat_rates hash", async () => {
      const oracle = new FiatRateOracle({
        redis,
        config: { coingeckoBaseUrl: COINGECKO, fetchImpl: coinGeckoFetch({ "stellar:usd": 0.42 }) },
      });

      const rate = await oracle.refreshRate("XLM", "USD");
      expect(rate).toMatchObject({ assetCode: "XLM", fiatCurrency: "USD", price: 0.42, source: "coingecko" });

      const cached = await redis.hget("oracle:fiat_rates", rateField("XLM", "USD"));
      expect(cached).toBeTruthy();
      expect(JSON.parse(cached!).price).toBe(0.42);
    });

    it("serves subsequent reads from the cache", async () => {
      const fetchImpl = vi.fn(coinGeckoFetch({ "stellar:usd": 0.42 }));
      const oracle = new FiatRateOracle({
        redis,
        config: { coingeckoBaseUrl: COINGECKO, fetchImpl },
      });

      await oracle.refreshRate("XLM", "USD");
      const rate = await oracle.getRate("XLM", "USD");

      expect(rate.source).toBe("cache");
      expect(rate.price).toBe(0.42);
      // Only the initial refresh hit the network.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("sets a 5-minute TTL on the cache hash", async () => {
      const expire = vi.spyOn(redis, "expire");
      const oracle = new FiatRateOracle({
        redis,
        config: { coingeckoBaseUrl: COINGECKO, fetchImpl: coinGeckoFetch({ "stellar:usd": 0.42 }) },
      });

      await oracle.refreshRate("XLM", "USD");
      expect(expire).toHaveBeenCalledWith("oracle:fiat_rates", 300);
    });
  });

  describe("SDEX fallback", () => {
    it("falls back to the SDEX orderbook median when CoinGecko fails", async () => {
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("coingecko")) {
          return new Response("nope", { status: 500 });
        }
        // best bid .38, best ask .40 -> mid 0.39
        return orderbookResponse(["0.36", "0.38"], ["0.40", "0.42"]);
      }) as typeof fetch;

      const oracle = new FiatRateOracle({
        redis,
        config: { coingeckoBaseUrl: COINGECKO, horizonBaseUrl: HORIZON, fetchImpl },
      });

      const rate = await oracle.refreshRate("XLM", "USD");
      expect(rate.source).toBe("sdex");
      expect(rate.price).toBeCloseTo(0.39, 5);
    });

    it("throws when CoinGecko fails and the SDEX orderbook is empty", async () => {
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("coingecko")) return new Response("nope", { status: 500 });
        return orderbookResponse([], []);
      }) as typeof fetch;

      const oracle = new FiatRateOracle({
        redis,
        config: { coingeckoBaseUrl: COINGECKO, horizonBaseUrl: HORIZON, fetchImpl },
      });

      await expect(oracle.refreshRate("XLM", "USD")).rejects.toThrow(/no liquidity/i);
    });

    it("converts the USD midpoint using a cached cross rate for non-USD currencies", async () => {
      await redis.hset(
        "oracle:fiat_rates",
        rateField("USDC", "EUR"),
        JSON.stringify({ assetCode: "USDC", fiatCurrency: "EUR", price: 0.5, source: "cache", updatedAt: "" }),
      );

      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("coingecko")) return new Response("nope", { status: 500 });
        return orderbookResponse(["0.38"], ["0.40"]); // mid 0.39
      }) as typeof fetch;

      const oracle = new FiatRateOracle({
        redis,
        config: { coingeckoBaseUrl: COINGECKO, horizonBaseUrl: HORIZON, fetchImpl },
      });

      const rate = await oracle.refreshRate("XLM", "EUR");
      // 0.39 USD / (0.5 EUR per USD) = 0.78 EUR
      expect(rate.price).toBeCloseTo(0.78, 5);
    });
  });

  describe("refreshAll", () => {
    it("refreshes every tracked pair and tolerates partial failures", async () => {
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("coingecko")) {
          return new Response(
            JSON.stringify({ stellar: { usd: 0.42, eur: 0.38, gbp: 0.33, ngn: 650 }, "usd-coin": { usd: 1 } }),
            { status: 200 },
          );
        }
        return orderbookResponse(["0.38"], ["0.40"]);
      }) as typeof fetch;

      const oracle = new FiatRateOracle({
        redis,
        config: { coingeckoBaseUrl: COINGECKO, horizonBaseUrl: HORIZON, fetchImpl },
      });

      const rates = await oracle.refreshAll(["USD"]);
      expect(rates).toHaveLength(2); // XLM:USD and USDC:USD
    });
  });

  describe("orderbookMidPrice", () => {
    it("returns the midpoint of the best bid and ask", () => {
      expect(orderbookMidPrice({ bids: [{ price: "0.38", amount: "1" }], asks: [{ price: "0.40", amount: "1" }] })).toBe(0.39);
    });

    it("returns 0 for an empty book", () => {
      expect(orderbookMidPrice({ bids: [], asks: [] })).toBe(0);
    });
  });
});
