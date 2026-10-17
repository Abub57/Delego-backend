/**
 * EphemeralSigner (Issue #353)
 *
 * Ephemeral keys used to sign automated micro-payment transactions (e.g.
 * session-key delegated contract calls, see `SessionKeySigner`) previously
 * lived on as decrypted strings/Keypair instances in process memory after
 * signing, exposing private key material to memory scrapers or core-dump
 * analysis.
 *
 * `EphemeralSigner`:
 *   - Decodes the StrKey-encoded secret seed into a mutable `Buffer` once,
 *     in the constructor — the raw secret *string* is never stored on a
 *     long-lived object property.
 *   - Signs using that buffer, then immediately zeroizes it (`fill(0)`)
 *     whether signing succeeds or throws, so the key bytes do not linger.
 *   - Treats the instance as single-use: a second `sign()` call after
 *     zeroization throws rather than silently signing with zeroed bytes.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { StrKey } from "@stellar/stellar-sdk";

export class EphemeralSigner {
  private keyBuffer: Buffer;
  private zeroized = false;

  constructor(secretKey: string) {
    // Raw 32-byte ed25519 seed. The StrKey-encoded `secretKey` argument is
    // only used here, synchronously, and is not assigned to `this`.
    this.keyBuffer = Buffer.from(StrKey.decodeEd25519SecretSeed(secretKey));
  }

  /**
   * Sign `data` with the ephemeral key, then zeroize the key buffer
   * immediately — on success or failure.
   *
   * Throws if the signer has already been zeroized (either by a prior
   * `sign()` call or an explicit `zeroize()`), so callers can't accidentally
   * sign with already-wiped key material.
   */
  public sign(data: Buffer): Buffer {
    if (this.zeroized) {
      throw new Error("EphemeralSigner: key material has already been zeroized");
    }
    try {
      const keypair = Keypair.fromRawEd25519Seed(this.keyBuffer);
      return Buffer.from(keypair.sign(data));
    } finally {
      this.zeroize();
    }
  }

  /**
   * Explicitly overwrite the key buffer with zeros. Idempotent — safe to
   * call multiple times (e.g. defensively in a `finally` block upstream).
   */
  public zeroize(): void {
    if (this.zeroized) {
      return;
    }
    this.keyBuffer.fill(0);
    this.zeroized = true;
  }

  /** Whether the key material has already been wiped from memory. */
  public isZeroized(): boolean {
    return this.zeroized;
  }
}
