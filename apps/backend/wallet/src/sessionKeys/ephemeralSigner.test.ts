/**
 * Tests for Issue #353 — in-memory zeroization of ephemeral session
 * private keys.
 */

import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { EphemeralSigner } from "./ephemeralSigner.js";

describe("EphemeralSigner", () => {
  it("produces a valid signature verifiable against the public key", () => {
    const keypair = Keypair.random();
    const signer = new EphemeralSigner(keypair.secret());
    const data = Buffer.from("payment-authorization");

    const signature = signer.sign(data);

    expect(keypair.verify(data, signature)).toBe(true);
  });

  it("zeroizes the key buffer immediately after signing", () => {
    const keypair = Keypair.random();
    const signer = new EphemeralSigner(keypair.secret());

    signer.sign(Buffer.from("tx-payload"));

    expect(signer.isZeroized()).toBe(true);
    // Internal buffer should be all zero bytes post-sign.
    const internalBuffer: Buffer = (signer as unknown as { keyBuffer: Buffer }).keyBuffer;
    expect(internalBuffer.every((byte) => byte === 0)).toBe(true);
  });

  it("throws rather than signing again once zeroized", () => {
    const keypair = Keypair.random();
    const signer = new EphemeralSigner(keypair.secret());

    signer.sign(Buffer.from("first-use"));

    expect(() => signer.sign(Buffer.from("second-use"))).toThrow(
      /already been zeroized/,
    );
  });

  it("zeroize() is safe to call explicitly and is idempotent", () => {
    const keypair = Keypair.random();
    const signer = new EphemeralSigner(keypair.secret());

    signer.zeroize();
    expect(signer.isZeroized()).toBe(true);

    // Calling again must not throw.
    expect(() => signer.zeroize()).not.toThrow();
  });

  it("zeroizes the key buffer even when signing throws", () => {
    const keypair = Keypair.random();
    const signer = new EphemeralSigner(keypair.secret());

    // Zeroize up front so the underlying sign() call is guaranteed to throw,
    // and confirm the error path still leaves zeroized === true (it never
    // un-sets it).
    signer.zeroize();
    expect(() => signer.sign(Buffer.from("will-fail"))).toThrow();
    expect(signer.isZeroized()).toBe(true);
  });

  it("never stores the raw secret string on the instance", () => {
    const keypair = Keypair.random();
    const secret = keypair.secret();
    const signer = new EphemeralSigner(secret);

    const ownValues = Object.values(signer as unknown as Record<string, unknown>);
    expect(ownValues).not.toContain(secret);
  });
});
