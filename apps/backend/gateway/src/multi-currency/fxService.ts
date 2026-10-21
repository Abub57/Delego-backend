import { Op } from "sequelize";
import { FXRate } from "../models/FXRate.js";
import { SupportedCurrency } from "../models/SupportedCurrency.js";
import type { FXRate as FXRateType, FXRateResponse, FXRateRequest } from "@delegolabs/types";
import { fetchWithCorrelation } from "../../middleware/correlation.js";

/**
 * FX Rate Service
 * Manages FX rates from multiple providers and calculates conversion paths
 */

const log = createChildLogger({ module: "fx-service" });

const FX_PROVIDERS = {
  stellar_lumen: "https://stellar-lumen-oracle.example.com",
  polygon_oracle: "https://polygon-oracle.example.com",
  chainlink: "https://chainlink-oracle.example.com",
};

/**
 * Fetch FX rate from a provider
 */
async function fetchFromProvider(provider: string, base: string, quote: string): Promise<FXRateResponse> {
  const url = `${FX_PROVIDERS[provider as keyof typeof FX_PROVIDERS]}/rates/${base}/${quote}`;
  
  try {
    const response = await fetchWithCorrelation(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`FX provider returned ${response.status}`);
    }

    const data = (await response.json()) as any;

    // Parse the rate data
    const now = new Date();
    const validUntil = new Date(now.getTime() + 60 * 1000); // Valid for 1 minute
    const rateNum = parseFloat(String(data.rate)) || 1;
    const spreadNum = parseFloat(String(data.spread)) || 0.005;
    const midRate = String(data.midRate || rateNum);
    const bid = String(data.bid || (rateNum * (1 - spreadNum / 2)));
    const ask = String(data.ask || (rateNum * (1 + spreadNum / 2)));

    return {
      baseCurrency: base,
      quoteCurrency: quote,
      rate: String(data.rate),
      source: provider,
      timestamp: now.toISOString(),
      validUntil: validUntil.toISOString(),
      spread: String(data.spread || "0.005"),
      midRate,
      bid,
      ask,
    };
  } catch (error) {
    log.error("Failed to fetch FX rate from provider", {
      provider,
      base,
      quote,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(`FX rate fetch failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * Get FX rate from database or fetch new one
 */
export async function getFXRate(request: FXRateRequest): Promise<FXRateType> {
  const { baseCurrency, quoteCurrency } = request;

  // Check if rate exists and is still valid
  const existingRate = await FXRate.findOne({
    where: {
      baseCurrency,
      quoteCurrency,
      validUntil: { [Op.gte]: new Date() },
    },
  });

  if (existingRate) {
    return {
      baseCurrency: existingRate.baseCurrency,
      quoteCurrency: existingRate.quoteCurrency,
      rate: existingRate.rate.toString(),
      source: existingRate.source,
      timestamp: existingRate.timestamp.toISOString(),
      validUntil: existingRate.validUntil.toISOString(),
      spread: existingRate.spread.toString(),
    };
  }

  // Get supported currencies to determine provider
  const baseCurrencyConfig = await SupportedCurrency.findByPk(baseCurrency);
  const provider = baseCurrencyConfig?.fxProvider || "stellar_lumen";

  // Fetch new rate
  const newRate = await fetchFromProvider(provider, baseCurrency, quoteCurrency);

  // Store in database
  await FXRate.upsert({
    baseCurrency,
    quoteCurrency,
    rate: newRate.rate,
    source: newRate.source,
    timestamp: newRate.timestamp,
    validUntil: newRate.validUntil,
    spread: newRate.spread,
    midRate: newRate.midRate,
    bid: newRate.bid,
    ask: newRate.ask,
  });

  return {
    baseCurrency: newRate.baseCurrency,
    quoteCurrency: newRate.quoteCurrency,
    rate: newRate.rate,
    source: newRate.source,
    timestamp: newRate.timestamp,
    validUntil: newRate.validUntil,
    spread: newRate.spread,
  };
}

/**
 * Calculate reverse FX rate
 */
export function getReverseFXRate(rate: FXRateType): FXRateType {
  const rateNum = parseFloat(rate.rate);
  const spreadNum = parseFloat(rate.spread);

  const midRate = rateNum;
  const reversedMidRate = 1 / midRate;

  const reversedSpread = spreadNum;

  return {
    baseCurrency: rate.quoteCurrency,
    quoteCurrency: rate.baseCurrency,
    rate: reversedMidRate.toString(),
    source: rate.source,
    timestamp: rate.timestamp,
    validUntil: rate.validUntil,
    spread: reversedSpread.toString(),
  };
}

/**
 * Find conversion path between two currencies
 * Uses Dijkstra's algorithm for shortest path
 */
export async function findConversionPath(
  fromCurrency: string,
  toCurrency: string
): Promise<{ path: Array<{ from: string; to: string; rate: string }>; totalRate: string }> {
  // Get all supported currencies
  const currencies = await SupportedCurrency.findAll({ where: { enabled: true } });
  const currencyCodes = currencies.map(c => c.code);

  if (!currencyCodes.includes(fromCurrency)) {
    throw new Error(`Source currency ${fromCurrency} is not supported`);
  }
  if (!currencyCodes.includes(toCurrency)) {
    throw new Error(`Destination currency ${toCurrency} is not supported`);
  }

  // Build adjacency graph of available rates
  const rates = await FXRate.findAll({
    where: {
      validUntil: { [Op.gte]: new Date() },
    },
  });

  const graph: Record<string, Record<string, number>> = {};
  for (const rate of rates) {
    if (!graph[rate.baseCurrency]) graph[rate.baseCurrency] = {};
    graph[rate.baseCurrency][rate.quoteCurrency] = parseFloat(rate.rate);
  }

  // Dijkstra's algorithm
  const distances: Record<string, number> = { [fromCurrency]: 1 };
  const previous: Record<string, string | null> = { [fromCurrency]: null };
  const visited = new Set<string>();
  const unvisited = new Set<string>(currencyCodes);

  while (unvisited.size > 0) {
    // Find unvisited node with smallest distance
    let current: string | undefined;
    let minDistance = Infinity;

    for (const currency of unvisited) {
      if (distances[currency] !== undefined && distances[currency] < minDistance) {
        minDistance = distances[currency];
        current = currency;
      }
    }

    if (!current || current === toCurrency) break;

    unvisited.delete(current);
    visited.add(current);

    // Update distances to neighbors
    if (graph[current]) {
      for (const neighbor of Object.keys(graph[current])) {
        if (!visited.has(neighbor) && unvisited.has(neighbor)) {
          const newDistance = distances[current] * graph[current][neighbor];
          if (!distances[neighbor] || newDistance < distances[neighbor]) {
            distances[neighbor] = newDistance;
            previous[neighbor] = current;
          }
        }
      }
    }
  }

  if (!distances[toCurrency]) {
    throw new Error(`No conversion path found from ${fromCurrency} to ${toCurrency}`);
  }

  // Reconstruct path
  const path: Array<{ from: string; to: string; rate: string }> = [];
  let current: string | undefined = toCurrency;
  let prev = previous[current];

  while (prev) {
    const rate = graph[prev][current];
    if (rate) {
      path.unshift({ from: prev, to: current, rate: rate.toString() });
    }
    current = prev;
    prev = previous[current];
  }

  return {
    path,
    totalRate: distances[toCurrency].toString(),
  };
}

/**
 * Batch fetch rates for multiple currency pairs
 */
export async function batchGetFXRates(pairs: Array<{ base: string; quote: string }>): Promise<FXRateType[]> {
  const rates: FXRateType[] = [];

  for (const pair of pairs) {
    try {
      const rate = await getFXRate({
        baseCurrency: pair.base,
        quoteCurrency: pair.quote,
      });
      rates.push(rate);
    } catch (error) {
      log.error("Failed to get FX rate for currency pair", {
        base: pair.base,
        quote: pair.quote,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return rates;
}

/**
 * Refresh all FX rates from providers
 */
export async function refreshAllFXRates(): Promise<void> {
  const currencies = await SupportedCurrency.findAll({ where: { enabled: true } });

  for (const currency of currencies) {
    for (const otherCurrency of currencies) {
      if (currency.code !== otherCurrency.code) {
        try {
          await getFXRate({
            baseCurrency: currency.code,
            quoteCurrency: otherCurrency.code,
          });
        } catch (error) {
          log.error("Failed to refresh FX rate", {
            baseCurrency: currency.code,
            quoteCurrency: otherCurrency.code,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}
