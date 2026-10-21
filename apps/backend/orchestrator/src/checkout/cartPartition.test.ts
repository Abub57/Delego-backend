/**
 * Unit tests for CartPartitionService.partitionByMerchant
 *
 * Tests cover:
 *   - Single and multi-merchant partitioning
 *   - BigInt subtotal / tax / shipping arithmetic
 *   - Escrow salt determinism
 *   - Merchant contract-binding validation (unverified, missing, no address)
 *   - Cart item validation (empty cart, bad quantity, bad price)
 *   - Stable output ordering
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Pool } from "pg";
import {
  CartPartitionService,
  CartValidationError,
  MerchantContractBindingError,
  type CheckoutCartItem,
  type PartitionedCheckoutBatch,
} from "./cartPartition.js";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Fake database pool
// ---------------------------------------------------------------------------

interface FakeMerchantRow {
  id: string;
  stellar_address: string;
  is_verified: boolean;
  soroban_contract_id: string | null;
}

function buildFakePool(merchants: FakeMerchantRow[]): Pool {
  return {
    async query(_sql: string, values?: unknown[]) {
      const ids = (values?.[0] as string[]) ?? [];
      const rows = merchants.filter((m) => ids.includes(m.id));
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MERCHANT_A: FakeMerchantRow = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  stellar_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  is_verified: true,
  soroban_contract_id: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
};

const MERCHANT_B: FakeMerchantRow = {
  id: "bbbbbbbb-0000-0000-0000-000000000002",
  stellar_address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF",
  is_verified: true,
  soroban_contract_id: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4",
};

const UNVERIFIED_MERCHANT: FakeMerchantRow = {
  id: "cccccccc-0000-0000-0000-000000000003",
  stellar_address: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF",
  is_verified: false,
  soroban_contract_id: null,
};

const NO_ADDRESS_MERCHANT: FakeMerchantRow = {
  id: "dddddddd-0000-0000-0000-000000000004",
  stellar_address: "",
  is_verified: true,
  soroban_contract_id: null,
};

const ORDER_ID = "order-00000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function item(merchantId: string, productId: string, qty: number, price: string): CheckoutCartItem {
  return { merchantId, productId, quantity: qty, unitPriceStroops: price };
}

function expectedSalt(orderId: string, merchantId: string): string {
  return crypto
    .createHash("sha256")
    .update(`${orderId}:${merchantId}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CartPartitionService.partitionByMerchant", () => {
  let service: CartPartitionService;

  beforeEach(() => {
    service = new CartPartitionService(
      buildFakePool([MERCHANT_A, MERCHANT_B, UNVERIFIED_MERCHANT, NO_ADDRESS_MERCHANT]),
    );
  });

  // ── Single-merchant cart ──────────────────────────────────────────────────

  it("returns one batch for a single-merchant cart", async () => {
    const items = [
      item(MERCHANT_A.id, "prod-1", 2, "5000000"),
      item(MERCHANT_A.id, "prod-2", 1, "3000000"),
    ];

    const batches = await service.partitionByMerchant(ORDER_ID, items);
    expect(batches).toHaveLength(1);
    expect(batches[0].merchantId).toBe(MERCHANT_A.id);
    expect(batches[0].items).toHaveLength(2);
  });

  it("sets the correct payout address from the merchant record", async () => {
    const batches = await service.partitionByMerchant(ORDER_ID, [
      item(MERCHANT_A.id, "prod-1", 1, "1000000"),
    ]);
    expect(batches[0].merchantPayoutAddress).toBe(MERCHANT_A.stellar_address);
  });

  // ── Multi-merchant cart ───────────────────────────────────────────────────

  it("returns two batches for a two-merchant cart", async () => {
    const items = [
      item(MERCHANT_A.id, "prod-1", 1, "1000000"),
      item(MERCHANT_B.id, "prod-2", 1, "2000000"),
      item(MERCHANT_A.id, "prod-3", 1, "500000"),
    ];

    const batches = await service.partitionByMerchant(ORDER_ID, items);
    expect(batches).toHaveLength(2);

    const batchA = batches.find((b) => b.merchantId === MERCHANT_A.id)!;
    const batchB = batches.find((b) => b.merchantId === MERCHANT_B.id)!;

    expect(batchA.items).toHaveLength(2);
    expect(batchB.items).toHaveLength(1);
  });

  it("sorts batches by merchantId for deterministic ordering", async () => {
    const items = [
      item(MERCHANT_B.id, "prod-2", 1, "1000000"),
      item(MERCHANT_A.id, "prod-1", 1, "1000000"),
    ];
    const batches = await service.partitionByMerchant(ORDER_ID, items);
    const ids = batches.map((b) => b.merchantId);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  // ── BigInt arithmetic ─────────────────────────────────────────────────────

  it("computes subtotal correctly using BigInt arithmetic", async () => {
    // 3 × 5_000_000 + 2 × 7_000_000 = 29_000_000
    const items = [
      item(MERCHANT_A.id, "prod-1", 3, "5000000"),
      item(MERCHANT_A.id, "prod-2", 2, "7000000"),
    ];
    const [batch] = await service.partitionByMerchant(ORDER_ID, items);
    expect(BigInt(batch.subtotalStroops)).toBe(29_000_000n);
  });

  it("computes tax as floor(subtotal × 875 / 10000)", async () => {
    const subtotal = 29_000_000n;
    const expectedTax = (subtotal * 875n) / 10_000n; // 2_537_500n

    const items = [
      item(MERCHANT_A.id, "prod-1", 3, "5000000"),
      item(MERCHANT_A.id, "prod-2", 2, "7000000"),
    ];
    const [batch] = await service.partitionByMerchant(ORDER_ID, items);
    expect(BigInt(batch.taxStroops)).toBe(expectedTax);
  });

  it("includes a flat 10_000_000 stroops shipping fee per merchant", async () => {
    const [batch] = await service.partitionByMerchant(ORDER_ID, [
      item(MERCHANT_A.id, "prod-1", 1, "1000000"),
    ]);
    expect(BigInt(batch.shippingStroops)).toBe(10_000_000n);
  });

  it("totalEscrowAmountStroops equals subtotal + tax + shipping", async () => {
    const [batch] = await service.partitionByMerchant(ORDER_ID, [
      item(MERCHANT_A.id, "prod-1", 2, "50000000"),
    ]);
    const expected =
      BigInt(batch.subtotalStroops) +
      BigInt(batch.taxStroops) +
      BigInt(batch.shippingStroops);
    expect(BigInt(batch.totalEscrowAmountStroops)).toBe(expected);
  });

  it("all stroop values are non-negative integer strings", async () => {
    const batches = await service.partitionByMerchant(ORDER_ID, [
      item(MERCHANT_A.id, "prod-1", 1, "1000000"),
      item(MERCHANT_B.id, "prod-2", 5, "2000000"),
    ]);
    for (const batch of batches) {
      for (const key of ["subtotalStroops", "taxStroops", "shippingStroops", "totalEscrowAmountStroops"] as const) {
        expect(() => BigInt(batch[key])).not.toThrow();
        expect(BigInt(batch[key])).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  // ── Escrow salt ───────────────────────────────────────────────────────────

  it("derives a deterministic escrow salt from orderId and merchantId", async () => {
    const [batch] = await service.partitionByMerchant(ORDER_ID, [
      item(MERCHANT_A.id, "prod-1", 1, "1000000"),
    ]);
    expect(batch.escrowSalt).toBe(expectedSalt(ORDER_ID, MERCHANT_A.id));
  });

  it("produces different salts for different merchants in the same order", async () => {
    const batches = await service.partitionByMerchant(ORDER_ID, [
      item(MERCHANT_A.id, "prod-1", 1, "1000000"),
      item(MERCHANT_B.id, "prod-2", 1, "2000000"),
    ]);
    expect(batches[0].escrowSalt).not.toBe(batches[1].escrowSalt);
  });

  it("produces the same salt for the same orderId + merchantId on repeated calls", async () => {
    const run1 = await service.partitionByMerchant(ORDER_ID, [
      item(MERCHANT_A.id, "prod-1", 1, "1000000"),
    ]);
    const run2 = await service.partitionByMerchant(ORDER_ID, [
      item(MERCHANT_A.id, "prod-1", 1, "1000000"),
    ]);
    expect(run1[0].escrowSalt).toBe(run2[0].escrowSalt);
  });

  // ── Merchant contract-binding validation ──────────────────────────────────

  it("throws MerchantContractBindingError for an unverified merchant", async () => {
    await expect(
      service.partitionByMerchant(ORDER_ID, [
        item(UNVERIFIED_MERCHANT.id, "prod-1", 1, "1000000"),
      ]),
    ).rejects.toThrow(MerchantContractBindingError);
  });

  it("carries the merchantId on MerchantContractBindingError", async () => {
    await expect(
      service.partitionByMerchant(ORDER_ID, [
        item(UNVERIFIED_MERCHANT.id, "prod-1", 1, "1000000"),
      ]),
    ).rejects.toMatchObject({ merchantId: UNVERIFIED_MERCHANT.id });
  });

  it("throws MerchantContractBindingError when merchant is not found in DB", async () => {
    await expect(
      service.partitionByMerchant(ORDER_ID, [
        item("ffffffff-ffff-ffff-ffff-ffffffffffff", "prod-1", 1, "1000000"),
      ]),
    ).rejects.toThrow(MerchantContractBindingError);
  });

  it("throws MerchantContractBindingError when merchant has no stellar_address", async () => {
    await expect(
      service.partitionByMerchant(ORDER_ID, [
        item(NO_ADDRESS_MERCHANT.id, "prod-1", 1, "1000000"),
      ]),
    ).rejects.toThrow(MerchantContractBindingError);
  });

  it("rejects the entire batch if even one merchant fails validation", async () => {
    // MERCHANT_A is valid, UNVERIFIED_MERCHANT is not.
    await expect(
      service.partitionByMerchant(ORDER_ID, [
        item(MERCHANT_A.id, "prod-1", 1, "1000000"),
        item(UNVERIFIED_MERCHANT.id, "prod-2", 1, "2000000"),
      ]),
    ).rejects.toThrow(MerchantContractBindingError);
  });

  // ── Cart validation ───────────────────────────────────────────────────────

  it("throws CartValidationError for an empty items array", async () => {
    await expect(service.partitionByMerchant(ORDER_ID, [])).rejects.toThrow(
      CartValidationError,
    );
  });

  it("throws CartValidationError for a zero quantity", async () => {
    await expect(
      service.partitionByMerchant(ORDER_ID, [
        item(MERCHANT_A.id, "prod-1", 0, "1000000"),
      ]),
    ).rejects.toThrow(CartValidationError);
  });

  it("throws CartValidationError for a negative quantity", async () => {
    await expect(
      service.partitionByMerchant(ORDER_ID, [
        item(MERCHANT_A.id, "prod-1", -1, "1000000"),
      ]),
    ).rejects.toThrow(CartValidationError);
  });

  it("throws CartValidationError for a non-integer unitPriceStroops", async () => {
    await expect(
      service.partitionByMerchant(ORDER_ID, [
        item(MERCHANT_A.id, "prod-1", 1, "3.14"),
      ]),
    ).rejects.toThrow(CartValidationError);
  });

  it("throws CartValidationError for a zero price", async () => {
    await expect(
      service.partitionByMerchant(ORDER_ID, [
        item(MERCHANT_A.id, "prod-1", 1, "0"),
      ]),
    ).rejects.toThrow(CartValidationError);
  });
});
