/**
 * Issue #369 — Automated Oracle Delivery Receipt Signing
 *
 * Public surface of the oracle module.
 */

export {
  LocalOracleKeySigner,
  AwsKmsOracleKeySigner,
  VaultOracleKeySigner,
  ORACLE_KEY_ALGORITHM,
  type OracleKeySigner,
  type OraclePublicKey,
  type OracleSignResult,
  type OracleKeyProvider,
} from "./keyProvider.js";
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
