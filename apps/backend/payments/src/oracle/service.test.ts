import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { LocalOracleKeySigner } from "./keyProvider.js";
import { resetOracleSigner, getOracleSigner } from "./config.js";
import { signDeliveryReceipt, verifyDeliveryReceipt } from "./service.js";
import { buildCanonicalDeliveryPayload, canonicalPayloadHash } from "./payload.js";

const baseInput = {
  escrowId: 7n,
  trackingNumber: "TRK-9",
  carrier: "FastFreight",
  deliveredAt: 1_700_000_000,
  oraclePublicKey: "ab",
};

describe("oracle service (local signer)", () => {
  beforeEach(() => {
    process.env.ORACLE_KEY_PROVIDER = "local";
    process.env.ORACLE_KEY_ID = "test-oracle";
    resetOracleSigner();
  });

  afterEach(() => {
    resetOracleSigner();
    delete process.env.ORACLE_KEY_PROVIDER;
    delete process.env.ORACLE_KEY_ID;
  });

  it("signs a delivery receipt with a 64-byte Ed25519 signature", async () => {
    const receipt = await signDeliveryReceipt(baseInput);
    expect(receipt.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(receipt.oraclePublicKey).toMatch(/^[0-9a-f]+$/);
    expect(receipt.signedPayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.signedAt).toBeTruthy();
    expect(receipt.escrowId).toBe(7n);
  });

  it("the signed payload hash matches the canonical payload hash", async () => {
    const receipt = await signDeliveryReceipt(baseInput);
    const payload = buildCanonicalDeliveryPayload(baseInput);
    expect(receipt.signedPayloadHash).toBe(canonicalPayloadHash(payload));
  });

  it("verifyDeliveryReceipt returns true for a validly signed receipt", async () => {
    const receipt = await signDeliveryReceipt(baseInput);
    expect(await verifyDeliveryReceipt(receipt)).toBe(true);
  });

  it("verifyDeliveryReceipt returns false when the payload hash is tampered", async () => {
    const receipt = (await signDeliveryReceipt(baseInput)) as any;
    receipt.signedPayloadHash = "0".repeat(64);
    expect(await verifyDeliveryReceipt(receipt)).toBe(false);
  });

  it("verifyDeliveryReceipt returns false for a malformed signature length", async () => {
    const receipt = (await signDeliveryReceipt(baseInput)) as any;
    receipt.signature = "ab";
    expect(await verifyDeliveryReceipt(receipt)).toBe(false);
  });

  it("the signer caches a single keypair across calls", async () => {
    const signer = getOracleSigner() as LocalOracleKeySigner;
    const a = await signer.getPublicKey();
    const b = await signer.getPublicKey();
    expect(a).toBe(b);
  });
});
