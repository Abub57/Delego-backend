/**
 * Issue #528 — `GET /api/v1/oracle/rates`
 *
 * Serves cached fiat exchange rates from the Redis hash `oracle:fiat_rates`,
 * refreshing from CoinGecko (falling back to Stellar SDEX) when asked or when
 * the cache is cold.
 */
import type { Route, RouteHandler } from "@delegolabs/utils";
import { route } from "@delegolabs/utils";
import { getRedisClient } from "../rateLimit/redisClient.js";
import { success, internalError, validationError } from "../errors.js";
import {
  FiatRateOracle,
  rateField,
  type FiatCurrency,
  type FiatPriceRate,
} from "./fiatRateOracle.js";

const VALID_FIAT: FiatCurrency[] = ["USD", "EUR", "GBP", "NGN"];

let oracle: FiatRateOracle | null = null;

export function getFiatRateOracle(): FiatRateOracle {
  if (!oracle) {
    oracle = new FiatRateOracle({ redis: getRedisClient() });
  }
  return oracle;
}

export function _setFiatRateOracleForTesting(instance: FiatRateOracle | null): void {
  oracle = instance;
}

/**
 * GET /api/v1/oracle/rates
 *
 * Query params:
 *   asset    — filter to a single asset (e.g. XLM)
 *   currency — filter to a single fiat currency (USD|EUR|GBP|NGN)
 *   refresh  — when "true", force a refresh from the upstream oracle
 */
export const getOracleRatesHandler: RouteHandler = async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const asset = url.searchParams.get("asset")?.toUpperCase();
    const currency = url.searchParams.get("currency")?.toUpperCase() as FiatCurrency | undefined;
    const refresh = url.searchParams.get("refresh") === "true";

    if (currency && !VALID_FIAT.includes(currency)) {
      validationError(res, `currency must be one of: ${VALID_FIAT.join(", ")}`, req);
      return;
    }

    const instance = getFiatRateOracle();

    if (refresh) {
      await instance.refreshAll(currency ? [currency] : VALID_FIAT);
    }

    const cached = await instance.getCachedRates();
    let items: FiatPriceRate[] = Object.values(cached);

    if (asset) {
      items = items.filter((rate) => rate.assetCode === asset);
    }
    if (currency) {
      items = items.filter((rate) => rate.fiatCurrency === currency);
    }

    // If the cache is empty (e.g. first boot), resolve on demand for the
    // requested pair rather than returning an empty envelope.
    if (items.length === 0 && asset && currency) {
      items = [await instance.getRate(asset, currency)];
    }

    success(
      res,
      {
        items,
        totalCount: items.length,
        cacheKey: "oracle:fiat_rates",
        ttlSeconds: 300,
      },
      req,
    );
  } catch (err) {
    internalError(
      res,
      err instanceof Error ? err.message : "Failed to resolve fiat rates",
      req,
    );
  }
};

export function registerOracleRateRoutes(): Route[] {
  return [route("GET", "/api/v1/oracle/rates", getOracleRatesHandler)];
}

export { rateField };
