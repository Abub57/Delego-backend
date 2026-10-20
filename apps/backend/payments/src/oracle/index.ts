/**
 * Issue #369 — Automated Oracle Delivery Receipt Signing
 *
 * Public surface of the oracle module.
 */

export {
  LocalOracleKeySigner,
  ORACLE_KEY_ALGORITHM,
  type OracleKeySigner,
  type OraclePublicKey,
  type OracleSignResult,
  type OracleKeyProvider,
} from "./keyProvider.js";
export { AwsKmsOracleKeySigner } from "./awsKmsSigner.js";
export { VaultOracleKeySigner } from "./vaultSigner.js";
export {
  getOracleSigner,
  getOracleSignerConfig,
  resetOracleSigner,
  DEFAULT_ORACLE_PROVIDER,
  type OracleSignerConfig,
} from "./config.js";
export {
  signDeliveryReceipt,
  verifyDeliveryReceipt,
  toOracleSigningError,
} from "./service.js";
export {
  buildCanonicalDeliveryPayload,
  canonicalPayloadHash,
} from "./payload.js";
export {
  registerOracleRoutes,
} from "./routes.js";
export type {
  OracleDeliveryReceiptInput,
  OracleSignedDeliveryReceipt,
  OracleSubmitReceiptResult,
  OracleSigningError,
  OracleSignatureVerificationError,
} from "./types.js";
