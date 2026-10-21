/*
 * Delivery zones matching for merchants (Issue: GET /api/v1/merchants/:id/delivery-zones).
 *
 * Provides a postal code prefix tree (Trie) and regex matcher that determines
 * whether a given destination postal code is covered by a merchant's delivery
 * service. The matching is pure and synchronous so it can run well under the
 * < 20 ms latency budget.
 */

export interface DeliveryZoneQuery {
  countryCode: string;
  postalCode: string;
}

export interface DeliveryZoneResponse {
  merchantId: string;
  isDeliverable: boolean;
  estimatedTransitDays: { min: number; max: number };
  baseShippingFeeStroops: string;
  carrierOptions: Array<{
    carrier: string;
    serviceName: string;
    costStroops: string;
  }>;
}

/** A single configured delivery zone for a merchant. */
export interface DeliveryZone {
  countryCode: string;
  /** Optional postal code prefixes covered by this zone. Empty means the
   * entire country is covered. */
  postalCodePrefixes?: string[];
  /** Optional regex pattern (as a string) that a postal code must match. */
  postalCodeRegex?: string;
  estimatedTransitDays: { min: number; max: number };
  baseShippingFeeStroops: string;
  carrierOptions: Array<{
    carrier: string;
    serviceName: string;
    costStroops: string;
  }>;
}

/** Postal code prefix trie node. */
interface TrieNode {
  children: Map<string, TrieNode>;
  /** True when a prefix terminates at this node. */
  isTerminal: boolean;
}

function createTrieNode(): TrieNode {
  return { children: new Map(), isTerminal: false };
}

/** Normalise a postal code for consistent matching. */
export function normalizePostalCode(postalCode: string): string {
  return postalCode.trim().toUpperCase().replace(/\s+/g, "");
}

/** Normalise a country code to uppercase ISO-3166-1 alpha-2. */
export function normalizeCountryCode(countryCode: string): string {
  return countryCode.trim().toUpperCase();
}

/** True when the value is a valid ISO-3166-1 alpha-2 country code. */
export function isValidCountryCode(countryCode: string): boolean {
  return /^[A-Za-z]{2}$/.test(countryCode.trim());
}

/** Build a prefix trie from a list of postal code prefixes. */
export function buildPrefixTrie(prefixes: string[]): TrieNode {
  const root = createTrieNode();
  for (const rawPrefix of prefixes) {
    const prefix = normalizePostalCode(rawPrefix);
    if (!prefix) continue;
    let node = root;
    for (const char of prefix) {
      let next = node.children.get(char);
      if (!next) {
        next = createTrieNode();
        node.children.set(char, next);
      }
      node = next;
    }
    node.isTerminal = true;
  }
  return root;
}

/** Return true if any terminal prefix in the trie is a prefix of the code. */
export function matchesPrefixTrie(root: TrieNode, postalCode: string): boolean {
  const code = normalizePostalCode(postalCode);
  if (!code) return false;
  let node = root;
  for (const char of code) {
    const next = node.children.get(char);
    if (!next) return false;
    node = next;
    if (node.isTerminal) return true;
  }
  return node.isTerminal;
}

/** Compile and cache a regex from a string pattern. */
export function compilePostalCodeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/** True when the postal code matches the compiled regex. */
export function matchesRegex(regex: RegExp | null, postalCode: string): boolean {
  if (!regex) return false;
  return regex.test(normalizePostalCode(postalCode));
}

/** Precompiled zone matcher ready for fast per-request matching. */
export interface CompiledDeliveryZone {
  countryCode: string;
  prefixTrie: TrieNode | null;
  regex: RegExp | null;
  estimatedTransitDays: { min: number; max: number };
  baseShippingFeeStroops: string;
  carrierOptions: Array<{
    carrier: string;
    serviceName: string;
    costStroops: string;
  }>;
}

/** Precompile delivery zones into a fast matcher structure. */
export function compileDeliveryZones(zones: DeliveryZone[]): CompiledDeliveryZone[] {
  return zones.map((zone) => ({
    countryCode: normalizeCountryCode(zone.countryCode),
    prefixTrie: zone.postalCodePrefixes && zone.postalCodePrefixes.length > 0
      ? buildPrefixTrie(zone.postalCodePrefixes)
      : null,
    regex: zone.postalCodeRegex ? compilePostalCodeRegex(zone.postalCodeRegex) : null,
    estimatedTransitDays: zone.estimatedTransitDays,
    baseShippingFeeStroops: zone.baseShippingFeeStroops,
    carrierOptions: zone.carrierOptions,
  }));
}

/** Return the first compiled zone that covers the given country + postal code. */
export function findMatchingZone(
  compiled: CompiledDeliveryZone[],
  countryCode: string,
  postalCode: string,
): CompiledDeliveryZone | null {
  const normalisedCountry = normalizeCountryCode(countryCode);
  for (const zone of compiled) {
    if (zone.countryCode !== normalisedCountry) continue;
    // A zone with neither prefixes nor a regex covers the entire country.
    if (!zone.prefixTrie && !zone.regex) return zone;
    if (zone.prefixTrie && matchesPrefixTrie(zone.prefixTrie, postalCode)) return zone;
    if (zone.regex && matchesRegex(zone.regex, postalCode)) return zone;
  }
  return null;
}

/** Build the delivery zone response from a match (or null when not covered). */
export function buildDeliveryZoneResponse(
  merchantId: string,
  matched: CompiledDeliveryZone | null,
  fallback?: {
    estimatedTransitDays?: { min: number; max: number };
    baseShippingFeeStroops?: string;
  },
): DeliveryZoneResponse {
  if (matched) {
    return {
      merchantId,
      isDeliverable: true,
      estimatedTransitDays: matched.estimatedTransitDays,
      baseShippingFeeStroops: matched.baseShippingFeeStroops,
      carrierOptions: matched.carrierOptions,
    };
  }
  return {
    merchantId,
    isDeliverable: false,
    estimatedTransitDays: fallback?.estimatedTransitDays ?? { min: 0, max: 0 },
    baseShippingFeeStroops: fallback?.baseShippingFeeStroops ?? "0",
    carrierOptions: [],
  };
}
