/**
 * Multi-Merchant Cart Partitioning & Soroban Batch Preparation
 *
 * When a buyer checks out with items from multiple merchants, this service:
 *   1. Partitions cart items by merchantId.
 *   2. Validates that every merchant has an active Soroban contract binding
 *      (stellar_address present and account is_verified) before committing.
 *   3. Computes per-merchant subtotal, tax, and shipping using BigInt stroop
 *      arithmetic so there is no floating-point drift on large amounts.
 *   4. Derives a deterministic escrow salt (SHA-256 of orderId + merchantId)
 *      so the frontend can generate the same salt independently for signing.
 *   5. Returns a structured batch payload formatted for frontend
 *      multi-transaction signing via Soroban.
 *
 * All monetary arithmetic is done in stroops (1 XLM = 10_000_000 stroops)
 * using BigInt to avoid IEEE-754 rounding on large values.
 */

import * as crypto from "node:crypto";
import type { Pool } from "pg";

// Minimal logger — avoids @delegolabs/utils → @delegolabs/types resolution
// failure in the test environment where workspace packages are not pre-built.
const log = {
  info: (msg: string, ctx?: Record<string, unknown>) => {
    console.info(`[orchestrator:checkout:cart-partition] ${msg}`, ctx ?? "");
  },
  warn: (msg: string, ctx?: Record<string, unknown>) => {
    console.warn(`[orchestrator:checkout:cart-partition] ${msg}`, ctx ?? "");
  },
};

// ---------------------------------------------------------------------------
// Public types (match the issue specification exactly)
// ---------------------------------------------------------------------------

export interface CheckoutCartItem {
  productId: string;
  merchantId: string;
  quantity: number;
  /** Unit price in stroops as a decimal string (BigInt-safe). */
  unitPriceStroops: string;
}

export interface PartitionedCheckoutBatch {
  merchantId: string;
  merchantPayoutAddress: string;
  items: CheckoutCartItem[];
  subtotalStroops: string;
  taxStroops: string;
  shippingStroops: string;
  totalEscrowAmountStroops: string;
  /** Deterministic salt derived from orderId + merchantId for escrow key derivation. */
  escrowSalt: string;
}

// ---------------------------------------------------------------------------
// Merchant validation types
// ---------------------------------------------------------------------------

interface MerchantRecord {
  id: string;
  stellar_address: string;
  is_verified: boolean;
  soroban_contract_id: string | null;
}

/** Thrown when any merchant in the cart lacks an active Soroban binding. */
export class MerchantContractBindingError extends Error {
  constructor(
    public readonly merchantId: string,
    public readonly reason: string,
  ) {
    super(`Merchant ${merchantId} cannot be checked out: ${reason}`);
    this.name = "MerchantContractBindingError";
  }
}

/** Thrown when cart items are empty or contain invalid quantities/prices. */
export class CartValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartValidationError";
  }
}

// ---------------------------------------------------------------------------
// Tax & shipping computation
// ---------------------------------------------------------------------------

/**
 * Default tax rate applied when no merchant-specific rate is configured.
 * Expressed in basis points (100 bp = 1 %).
 */
const DEFAULT_TAX_RATE_BASIS_POINTS = 875; // 8.75 %

/**
 * Flat per-merchant shipping fee in stroops.
 * A production implementation would look this up from the merchant profile
 * or a shipping-rate table; this constant keeps the service self-contained.
 */
const DEFAULT_SHIPPING_STROOPS = 10_000_000n; // 1 XLM

/**
 * Compute tax amount from a subtotal using integer basis-point arithmetic.
 *
 *   tax = floor(subtotal * basisPoints / 10_000)
 *
 * The floor keeps the result conservative (buyer is never overcharged by a
 * rounding artefact).
 */
function computeTax(subtotalStroops: bigint, taxRateBasisPoints: number): bigint {
  return (subtotalStroops * BigInt(taxRateBasisPoints)) / 10_000n;
}

/**
 * Derive a deterministic, unforgeable escrow salt from the orderId and
 * merchantId.  SHA-256 gives a 32-byte output; we hex-encode it to produce
 * a 64-character string the Soroban contract can ingest as a `Bytes32`.
 */
function deriveEscrowSalt(orderId: string, merchantId: string): string {
  return crypto
    .createHash("sha256")
    .update(`${orderId}:${merchantId}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// CartPartitionService
// ---------------------------------------------------------------------------

export class CartPartitionService {
  constructor(private readonly pool: Pool) {}

  /**
   * Partition `cartItems` by merchant, validate Soroban contract bindings,
   * compute per-merchant financials, and return one `PartitionedCheckoutBatch`
   * per merchant.
   *
   * @param orderId  The order ID used for escrow salt derivation.
   * @param cartItems  All items in the buyer's cart.
   * @returns  One batch per distinct merchant, ready for frontend signing.
   *
   * @throws CartValidationError   if items are empty or contain bad values.
   * @throws MerchantContractBindingError  if any merchant is unverified or
   *                                        lacks a Soroban contract binding.
   */
  async partitionByMerchant(
    orderId: string,
    cartItems: CheckoutCartItem[],
  ): Promise<PartitionedCheckoutBatch[]> {
    if (cartItems.length === 0) {
      throw new CartValidationError("Cart must contain at least one item");
    }

    this.validateCartItems(cartItems);

    // Group items by merchantId.
    const byMerchant = new Map<string, CheckoutCartItem[]>();
    for (const item of cartItems) {
      const bucket = byMerchant.get(item.merchantId) ?? [];
      bucket.push(item);
      byMerchant.set(item.merchantId, bucket);
    }

    const merchantIds = [...byMerchant.keys()];

    // Load merchant records and validate Soroban bindings in one query.
    const merchants = await this.loadAndValidateMerchants(merchantIds);

    // Build one batch per merchant.
    const batches: PartitionedCheckoutBatch[] = [];
    for (const [merchantId, items] of byMerchant) {
      const merchant = merchants.get(merchantId)!; // existence guaranteed by validateMerchants

      const subtotalStroops = items.reduce((acc, item) => {
        return acc + BigInt(item.unitPriceStroops) * BigInt(item.quantity);
      }, 0n);

      const taxStroops = computeTax(subtotalStroops, DEFAULT_TAX_RATE_BASIS_POINTS);
      const shippingStroops = DEFAULT_SHIPPING_STROOPS;
      const totalEscrowAmountStroops = subtotalStroops + taxStroops + shippingStroops;
      const escrowSalt = deriveEscrowSalt(orderId, merchantId);

      batches.push({
        merchantId,
        merchantPayoutAddress: merchant.stellar_address,
        items,
        subtotalStroops: subtotalStroops.toString(),
        taxStroops: taxStroops.toString(),
        shippingStroops: shippingStroops.toString(),
        totalEscrowAmountStroops: totalEscrowAmountStroops.toString(),
        escrowSalt,
      });

      log.info("Merchant batch partitioned", {
        orderId,
        merchantId,
        itemCount: items.length,
        subtotalStroops: subtotalStroops.toString(),
        taxStroops: taxStroops.toString(),
        totalEscrowAmountStroops: totalEscrowAmountStroops.toString(),
      });
    }

    // Stable output order: sort by merchantId so the caller gets deterministic
    // results regardless of Map iteration order.
    batches.sort((a, b) => a.merchantId.localeCompare(b.merchantId));
    return batches;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Validate all cart items have positive integer quantities and positive BigInt prices. */
  private validateCartItems(items: CheckoutCartItem[]): void {
    for (const item of items) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new CartValidationError(
          `Item for product ${item.productId} has an invalid quantity: ${item.quantity}`,
        );
      }
      let price: bigint;
      try {
        price = BigInt(item.unitPriceStroops);
      } catch {
        throw new CartValidationError(
          `Item for product ${item.productId} has a non-integer unitPriceStroops: "${item.unitPriceStroops}"`,
        );
      }
      if (price <= 0n) {
        throw new CartValidationError(
          `Item for product ${item.productId} has a non-positive unitPriceStroops: ${price}`,
        );
      }
    }
  }

  /**
   * Load merchant rows for all requested IDs and validate that each one:
   *   - exists in the database,
   *   - has a non-empty `stellar_address` (the Soroban payout target), and
   *   - is verified (`is_verified = true`).
   *
   * Using a single batched query keeps latency proportional to one round-trip
   * regardless of how many merchants are in the cart.
   */
  private async loadAndValidateMerchants(
    merchantIds: string[],
  ): Promise<Map<string, MerchantRecord>> {
    const { rows } = await this.pool.query<MerchantRecord>(
      `SELECT id, stellar_address, is_verified, soroban_contract_id
         FROM merchants
        WHERE id = ANY($1::uuid[])`,
      [merchantIds],
    );

    const byId = new Map<string, MerchantRecord>(rows.map((r) => [r.id, r]));

    for (const merchantId of merchantIds) {
      const merchant = byId.get(merchantId);

      if (!merchant) {
        throw new MerchantContractBindingError(merchantId, "merchant not found");
      }
      if (!merchant.is_verified) {
        throw new MerchantContractBindingError(
          merchantId,
          "merchant account is not verified",
        );
      }
      if (!merchant.stellar_address || merchant.stellar_address.trim() === "") {
        throw new MerchantContractBindingError(
          merchantId,
          "merchant has no Soroban payout address (stellar_address is empty)",
        );
      }
    }

    return byId;
  }
}
