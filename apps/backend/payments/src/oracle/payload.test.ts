import { describe, expect, it } from "vitest";
import { buildCanonicalDeliveryPayload, canonicalPayloadHash } from "./payload.js";

const baseInput = {
  escrowId: 42n,
  trackingNumber: "TRK-12345",
  carrier: "FastFreight",
  deliveredAt: 1_700_000_000,
  oraclePublicKey: "deadbeefcafe",
};

describe("buildCanonicalDeliveryPayload", () => {
  it("produces a deterministic buffer for identical input", () => {
    const a = buildCanonicalDeliveryPayload(baseInput);
    const b = buildCanonicalDeliveryPayload(baseInput);
    expect(a.equals(b)).toBe(true);
  });

  it("encodes escrowId as 8-byte LE uint64 at offset 0", () => {
    const payload = buildCanonicalDeliveryPayload({ ...baseInput, escrowId: 1n });
    expect(payload.subarray(0, 8).readBigUInt64LE()).toBe(1n);
  });

  it("encodes deliveredAt as 8-byte LE int64 after the variable fields", () => {
    const payload = buildCanonicalDeliveryPayload(baseInput);
    // Layout: escrowId(8) + tracking(2+len) + carrier(2+len) + deliveredAt(8) + pub(2+len)
    const trackingLen = Buffer.byteLength(baseInput.trackingNumber, "utf8");
    const carrierLen = Buffer.byteLength(baseInput.carrier, "utf8");
    const deliveredAtOffset = 8 + 2 + trackingLen + 2 + carrierLen;
    expect(payload.subarray(deliveredAtOffset, deliveredAtOffset + 8).readBigInt64LE()).toBe(
      BigInt(baseInput.deliveredAt)
    );
  });

  it("rejects a non-integer escrowId", () => {
    expect(() =>
      buildCanonicalDeliveryPayload({ ...baseInput, escrowId: -1n })
    ).toThrow(/escrowId/);
  });

  it("rejects an empty trackingNumber", () => {
    expect(() =>
      buildCanonicalDeliveryPayload({ ...baseInput, trackingNumber: "" })
    ).toThrow(/trackingNumber/);
  });

  it("rejects an oversized trackingNumber (>65535 bytes)", () => {
    expect(() =>
      buildCanonicalDeliveryPayload({ ...baseInput, trackingNumber: "x".repeat(70000) })
    ).toThrow(/65535/);
  });

  it("differs when any field changes (tamper detection)", () => {
    const original = buildCanonicalDeliveryPayload(baseInput);
    const tampered = buildCanonicalDeliveryPayload({
      ...baseInput,
      carrier: "EvilFreight",
    });
    expect(original.equals(tampered)).toBe(false);
  });
});

describe("canonicalPayloadHash", () => {
  it("returns a 64-char hex SHA-256 digest", () => {
    const payload = buildCanonicalDeliveryPayload(baseInput);
    const hash = canonicalPayloadHash(payload);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same payload", () => {
    const payload = buildCanonicalDeliveryPayload(baseInput);
    expect(canonicalPayloadHash(payload)).toBe(canonicalPayloadHash(payload));
  });
});
