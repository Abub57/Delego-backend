/**
 * Issue #369 — Canonical binary delivery payload.
 *
 * The oracle signs a deterministic binary encoding of the receipt fields so
 * that the on-chain Soroban escrow contract can reconstruct the *exact* same
 * bytes and verify the Ed25519 signature against the registered oracle public
 * key.
 *
 * Wire format (all fields little-endian where fixed-width):
 *
 *   escrowId      : 8 bytes  uint64 LE
 *   trackingNumber: 2 bytes length prefix (uint16 LE) + UTF-8 bytes
 *   carrier       : 2 bytes length prefix (uint16 LE) + UTF-8 bytes
 *   deliveredAt  : 8 bytes  int64 LE (seconds since epoch)
 *   oraclePublicKey: 2 bytes length prefix (uint16 LE) + UTF-8 bytes
 *
 * The length prefixes make the layout self-describing and robust against
 * trailing/missing bytes. The payload is deliberately *not* JSON: JSON
 * ordering and whitespace would make byte-for-byte reconstruction fragile.
 */

import { createHash } from "node:crypto";
import type { OracleDeliveryReceiptInput } from "./types.js";

const ESCROW_ID_BYTES = 8;
const DELIVERED_AT_BYTES = 8;
const LENGTH_PREFIX_BYTES = 2;

function writeU16LE(buf: Buffer, value: number, offset: number): void {
  buf.writeUInt16LE(value & 0xffff, offset);
}

function writeU64LE(buf: Buffer, value: bigint, offset: number): void {
  // BigInt is signed; encode as unsigned 64-bit two's complement.
  const asUint64 = BigInt.asUintN(64, value);
  let remaining = asUint64;
  for (let i = 0; i < ESCROW_ID_BYTES; i++) {
    buf[offset + i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function writeI64LE(buf: Buffer, value: number, offset: number): void {
  // Encode a JS number (seconds) as signed int64 LE.
  let n = Math.trunc(value);
  if (!Number.isFinite(n)) n = 0;
  // Two's complement into 64-bit unsigned representation.
  let asUint64 = BigInt.asIntN(64, BigInt(n));
  asUint64 = BigInt.asUintN(64, asUint64);
  let remaining = asUint64;
  for (let i = 0; i < DELIVERED_AT_BYTES; i++) {
    buf[offset + i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function encodePrefixedString(value: string): Buffer {
  const strBytes = Buffer.from(value, "utf8");
  if (strBytes.length > 0xffff) {
    throw new Error(`Field exceeds 65535 bytes: ${value.slice(0, 32)}...`);
  }
  const buf = Buffer.alloc(LENGTH_PREFIX_BYTES + strBytes.length);
  writeU16LE(buf, strBytes.length, 0);
  strBytes.copy(buf, LENGTH_PREFIX_BYTES);
  return buf;
}

/**
 * Build the canonical binary payload for a delivery receipt.
 *
 * Throws {@link Error} on invalid input (non-integer escrowId, empty
 * required fields, oversized strings) so callers can reject malformed
 * receipts before any signing work happens.
 */
export function buildCanonicalDeliveryPayload(input: OracleDeliveryReceiptInput): Buffer {
  if (!Number.isInteger(input.escrowId) || input.escrowId < 0) {
    throw new Error(`escrowId must be a non-negative integer, got ${input.escrowId}`);
  }
  if (typeof input.trackingNumber !== "string" || input.trackingNumber.length === 0) {
    throw new Error("trackingNumber is required");
  }
  if (typeof input.carrier !== "string" || input.carrier.length === 0) {
    throw new Error("carrier is required");
  }
  if (!Number.isInteger(input.deliveredAt) || input.deliveredAt < 0) {
    throw new Error(`deliveredAt must be a non-negative integer (epoch seconds), got ${input.deliveredAt}`);
  }
  if (typeof input.oraclePublicKey !== "string" || input.oraclePublicKey.length === 0) {
    throw new Error("oraclePublicKey is required");
  }

  const escrowBuf = Buffer.alloc(ESCROW_ID_BYTES);
  writeU64LE(escrowBuf, BigInt(input.escrowId), 0);

  const deliveredBuf = Buffer.alloc(DELIVERED_AT_BYTES);
  writeI64LE(deliveredBuf, input.deliveredAt, 0);

  const trackingBuf = encodePrefixedString(input.trackingNumber);
  const carrierBuf = encodePrefixedString(input.carrier);
  const pubBuf = encodePrefixedString(input.oraclePublicKey);

  const total =
    escrowBuf.length +
    trackingBuf.length +
    carrierBuf.length +
    deliveredBuf.length +
    pubBuf.length;
  const payload = Buffer.alloc(total);
  let offset = 0;
  escrowBuf.copy(payload, offset);
  offset += escrowBuf.length;
  trackingBuf.copy(payload, offset);
  offset += trackingBuf.length;
  carrierBuf.copy(payload, offset);
  offset += carrierBuf.length;
  deliveredBuf.copy(payload, offset);
  offset += deliveredBuf.length;
  pubBuf.copy(payload, offset);
  offset += pubBuf.length;

  if (offset !== total) {
    throw new Error("Internal error: canonical payload length mismatch");
  }
  return payload;
}

/** Hex digest of the canonical payload (used as `signedPayloadHash`). */
export function canonicalPayloadHash(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}