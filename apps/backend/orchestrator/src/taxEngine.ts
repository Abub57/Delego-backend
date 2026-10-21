import type { CacheRedisClient } from "@delegolabs/cache";

export interface TaxCalculationRequest {
  merchantCountry: string;
  destinationCountry: string;
  destinationPostalCode: string;
  destinationState?: string;
  itemsSubtotalStroops: string;
  shippingFeeStroops: string;
  productCategory: "digital" | "physical" | "exempt";
}

export interface TaxCalculationResult {
  taxJurisdiction: string;
  taxRatePercent: number;
  taxAmountStroops: string;
  isTaxExempt: boolean;
  reverseChargeApplied: boolean;
}

export const TAX_RATE_CACHE_TTL_SECONDS = 24 * 60 * 60;

const EU_VAT_TABLE: Record<string, number> = {
  AT: 20,
  BE: 21,
  BG: 20,
  HR: 25,
  CY: 19,
  CZ: 21,
  DK: 25,
  EE: 20,
  FI: 24,
  FR: 20,
  DE: 19,
  GR: 24,
  HU: 27,
  IE: 23,
  IT: 22,
  LV: 21,
  LT: 21,
  LU: 17,
  MT: 18,
  NL: 21,
  PL: 23,
  PT: 23,
  RO: 19,
  SK: 20,
  SI: 22,
  ES: 21,
  SE: 25,
};

const US_STATE_SALES_TAX_BASELINE: Record<string, number> = {
  AL: 4,
  AK: 0,
  AZ: 5.6,
  AR: 6.5,
  CA: 7.25,
  CO: 2.9,
  CT: 6.35,
  DE: 0,
  DC: 5.75,
  FL: 6,
  GA: 4,
  HI: 4.35,
  ID: 6,
  IL: 6.25,
  IN: 7,
  IA: 6,
  KS: 6.5,
  KY: 6,
  LA: 4.45,
  ME: 5.5,
  MD: 6,
  MA: 6.25,
  MI: 6,
  MN: 6.875,
  MS: 7,
  MO: 4.225,
  MT: 0,
  NE: 5.5,
  NV: 6.85,
  NH: 0,
  NJ: 6.625,
  NM: 5.125,
  NY: 4,
  NC: 4.75,
  ND: 5,
  OH: 5.75,
  OK: 4.5,
  OR: 0,
  PA: 6,
  RI: 7,
  SC: 6,
  SD: 4.5,
  TN: 7,
  TX: 6.25,
  UT: 5.95,
  VT: 6,
  VA: 5.3,
  WA: 6.5,
  WV: 6,
  WI: 5,
  WY: 4,
};

export function normalizeCountryCode(value: string): string {
  return (value ?? "").trim().toUpperCase();
}

export function normalizeStateCode(value?: string): string | undefined {
  if (!value) return undefined;
  return value.trim().toUpperCase();
}

export function isEuCountry(countryCode: string): boolean {
  return Boolean(EU_VAT_TABLE[normalizeCountryCode(countryCode)] !== undefined);
}

export function isUsState(stateCode?: string): boolean {
  return Boolean(stateCode && US_STATE_SALES_TAX_BASELINE[normalizeStateCode(stateCode) ?? ""] !== undefined);
}

export function getEuVatRate(countryCode: string): number {
  return EU_VAT_TABLE[normalizeCountryCode(countryCode)] ?? 0;
}

export function getUsStateSalesTaxRate(stateCode?: string): number {
  if (!stateCode) return 0;
  return US_STATE_SALES_TAX_BASELINE[normalizeStateCode(stateCode) ?? ""] ?? 0;
}

export function taxRateCacheKey(jurisdiction: string): string {
  return `tax:rate:${normalizeCountryCode(jurisdiction)}`;
}

export async function getCachedTaxRate(
  client: Pick<CacheRedisClient, "get"> | undefined,
  jurisdiction: string
): Promise<number | null> {
  if (!client) return null;

  const raw = await client.get(taxRateCacheKey(jurisdiction));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { ratePercent?: number };
    return typeof parsed.ratePercent === "number" ? parsed.ratePercent : null;
  } catch {
    return null;
  }
}

export async function cacheTaxRate(
  client: Pick<CacheRedisClient, "set"> | undefined,
  jurisdiction: string,
  ratePercent: number
): Promise<void> {
  if (!client) return;

  await client.set(
    taxRateCacheKey(jurisdiction),
    JSON.stringify({ ratePercent, cachedAt: new Date().toISOString() }),
    "EX",
    TAX_RATE_CACHE_TTL_SECONDS
  );
}

export async function resolveTaxRate(
  request: Pick<TaxCalculationRequest, "merchantCountry" | "destinationCountry" | "destinationState">,
  redisClient?: Pick<CacheRedisClient, "get" | "set">
): Promise<{ jurisdiction: string; ratePercent: number; fromCache: boolean }> {
  const merchantCountry = normalizeCountryCode(request.merchantCountry);
  const destinationCountry = normalizeCountryCode(request.destinationCountry);
  const destinationState = normalizeStateCode(request.destinationState);

  let jurisdiction = destinationCountry;
  let ratePercent = 0;

  if (destinationCountry === "US" && destinationState) {
    jurisdiction = `${destinationCountry}:${destinationState}`;
    ratePercent = getUsStateSalesTaxRate(destinationState);
  } else if (isEuCountry(destinationCountry)) {
    jurisdiction = destinationCountry;
    ratePercent = getEuVatRate(destinationCountry);
  } else if (merchantCountry === destinationCountry && isEuCountry(merchantCountry)) {
    jurisdiction = merchantCountry;
    ratePercent = getEuVatRate(merchantCountry);
  } else if (destinationCountry === "US" && !destinationState) {
    jurisdiction = "US";
    ratePercent = 0;
  }

  const cachedRate = await getCachedTaxRate(redisClient, jurisdiction);
  if (cachedRate !== null) {
    return { jurisdiction, ratePercent: cachedRate, fromCache: true };
  }

  if (ratePercent > 0) {
    await cacheTaxRate(redisClient, jurisdiction, ratePercent);
  }

  return { jurisdiction, ratePercent, fromCache: false };
}

function parseStroops(value: string | undefined): number {
  const sanitized = (value ?? "0").trim();
  if (!sanitized) return 0;
  const parsed = Number(sanitized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toTaxAmountStroops(baseAmount: number, ratePercent: number): string {
  const tax = baseAmount * (ratePercent / 100);
  return Math.round(tax).toString();
}

function isBusinessReverseChargeOrder(request: TaxCalculationRequest): boolean {
  const merchantCountry = normalizeCountryCode(request.merchantCountry);
  const destinationCountry = normalizeCountryCode(request.destinationCountry);
  const isIntraEu = isEuCountry(merchantCountry) && isEuCountry(destinationCountry);
  return isIntraEu && request.productCategory === "digital";
}

export async function calculateTax(
  request: TaxCalculationRequest,
  redisClient?: Pick<CacheRedisClient, "get" | "set">
): Promise<TaxCalculationResult> {
  const merchantCountry = normalizeCountryCode(request.merchantCountry);
  const destinationCountry = normalizeCountryCode(request.destinationCountry);
  const destinationState = normalizeStateCode(request.destinationState);

  const exemptInternationalExport =
    request.productCategory !== "exempt" &&
    merchantCountry !== destinationCountry &&
    !isEuCountry(destinationCountry) &&
    !isUsState(destinationState) &&
    !isEuCountry(merchantCountry);

  if (request.productCategory === "exempt" || exemptInternationalExport) {
    return {
      taxJurisdiction: destinationCountry || "INTERNATIONAL",
      taxRatePercent: 0,
      taxAmountStroops: "0",
      isTaxExempt: true,
      reverseChargeApplied: false,
    };
  }

  const { jurisdiction, ratePercent } = await resolveTaxRate(
    {
      merchantCountry,
      destinationCountry,
      destinationState,
    },
    redisClient
  );

  const reverseCharge = isBusinessReverseChargeOrder(request);
  const taxBase = parseStroops(request.itemsSubtotalStroops) + parseStroops(request.shippingFeeStroops);
  const computedTaxAmount = toTaxAmountStroops(taxBase, ratePercent);

  return {
    taxJurisdiction: jurisdiction,
    taxRatePercent: ratePercent,
    taxAmountStroops: reverseCharge ? "0" : computedTaxAmount,
    isTaxExempt: false,
    reverseChargeApplied: reverseCharge,
  };
}
