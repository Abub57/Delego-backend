/**
 * Type validation for a single catalog CSV row.
 *
 * Header names are matched loosely (`price_stroops`, `priceStroops` and
 * `Price Stroops` are equivalent). Constraints mirror the `products` table
 * (migration 041) so a validated row can only fail at insert time for
 * reasons outside the row itself.
 */

import type { CatalogProductInput } from "./types.js";

const MAX_SKU_LENGTH = 64;
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 10_000;
const MAX_INT32 = 2_147_483_647;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;
const UNSIGNED_INT_RE = /^\d+$/;

export type RowValidationResult =
  | { ok: true; product: CatalogProductInput }
  | { ok: false; reason: string };

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Map raw CSV columns to normalized keys, trimming every value. */
export function normalizeRow(raw: Record<string, string>): Record<string, string> {
  const row: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    row[normalizeHeader(key)] = typeof value === "string" ? value.trim() : "";
  }
  return row;
}

function parseBoolean(value: string): boolean | null {
  switch (value.toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "y":
      return true;
    case "false":
    case "0":
    case "no":
    case "n":
      return false;
    default:
      return null;
  }
}

export function validateCatalogRow(
  raw: Record<string, string>,
  rowNumber: number,
): RowValidationResult {
  const row = normalizeRow(raw);
  const errors: string[] = [];

  const sku = row.sku ?? "";
  if (!sku) errors.push("sku is required");
  else if (sku.length > MAX_SKU_LENGTH) errors.push(`sku must be at most ${MAX_SKU_LENGTH} characters`);

  const title = row.title ?? "";
  if (!title) errors.push("title is required");
  else if (title.length > MAX_TITLE_LENGTH) errors.push(`title must be at most ${MAX_TITLE_LENGTH} characters`);

  const description = row.description ? row.description : null;
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  const priceRaw = row.pricestroops ?? "";
  if (!UNSIGNED_INT_RE.test(priceRaw)) {
    errors.push("price_stroops must be a positive integer");
  } else {
    const price = BigInt(priceRaw);
    if (price <= 0n || price > MAX_BIGINT) errors.push("price_stroops is out of range");
  }

  const assetCode = row.assetcode || "USDC";
  if (!ASSET_CODE_RE.test(assetCode)) errors.push("asset_code must be 1-12 alphanumeric characters");

  let stockQuantity = 0;
  if (row.stockquantity) {
    if (!UNSIGNED_INT_RE.test(row.stockquantity) || Number(row.stockquantity) > MAX_INT32) {
      errors.push("stock_quantity must be a non-negative integer");
    } else {
      stockQuantity = Number(row.stockquantity);
    }
  }

  let isListed = true;
  if (row.islisted) {
    const parsed = parseBoolean(row.islisted);
    if (parsed === null) errors.push("is_listed must be true or false");
    else isListed = parsed;
  }

  let imageUrl: string | null = null;
  if (row.imageurl) {
    try {
      const url = new URL(row.imageurl);
      if (url.protocol !== "https:") errors.push("image_url must use https");
      else imageUrl = url.toString();
    } catch {
      errors.push("image_url is not a valid URL");
    }
  }

  let metadata: Record<string, unknown> = {};
  if (row.metadata) {
    try {
      const parsed: unknown = JSON.parse(row.metadata);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push("metadata must be a JSON object");
      } else {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      errors.push("metadata must be valid JSON");
    }
  }

  if (errors.length > 0) return { ok: false, reason: errors.join("; ") };

  return {
    ok: true,
    product: {
      rowNumber,
      sku,
      title,
      description,
      priceStroops: priceRaw.replace(/^0+(?=\d)/, ""),
      assetCode,
      stockQuantity,
      isListed,
      imageUrl,
      metadata,
    },
  };
}
