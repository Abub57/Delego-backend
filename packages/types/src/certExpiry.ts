/**
 * SSL/TLS certificate expiry monitoring types (Issue #390).
 */

/** Threshold in days for treating a certificate as expiring soon. */
export const CERT_EXPIRY_WARNING_DAYS = 14;

/** Status of a TLS certificate for a domain, as observed live. */
export type CertExpiryStatus = "ok" | "expiring_soon" | "expired" | "unreachable" | "unknown";

/**
 * Result of inspecting a merchant storefront's TLS certificate.
 * Returned by the socket probe and surfaced via the expiry API.
 */
export interface CertStatus {
  domain: string;
  /** Certificate expiry (notAfter). */
  validTo: Date;
  /** Whole days from now until expiry (negative when already expired). */
  daysRemaining: number;
  /** True when `daysRemaining` is at or below the warning threshold (or already expired). */
  isExpiringSoon: boolean;
}

/** A single observed certificate check for a merchant domain. */
export interface MerchantDomainCertCheck {
  merchantId: string;
  domain: string;
  /** ISO-8601 timestamp of when the check ran. */
  checkedAt: string;
  status: CertExpiryStatus;
  /** Full status when the probe succeeded; undefined otherwise. */
  certStatus?: CertStatus;
  /** Error detail when the probe or alert emission failed. */
  error?: string;
  /** True when an alert was emitted during this check. */
  alertEmitted: boolean;
}

/** Payload delivered to alert sinks when a certificate is expiring soon. */
export interface CertExpiryAlert {
  merchantId: string;
  domain: string;
  status: CertExpiryStatus;
  /** ISO-8601 certificate expiry (notAfter); undefined when unreachable. */
  validTo?: string;
  daysRemaining?: number;
  message: string;
  /** ISO-8601 timestamp of when the alert was raised. */
  raisedAt: string;
}

/** Sink that receives certificate expiry alerts (logging, webhook, ...). */
export interface CertExpiryAlerter {
  /**
   * Delivers an alert. Resolves `true` when the alert reached a sink and
   * `false` when it was suppressed (e.g. deduped); rejects on delivery errors.
   */
  emit(alert: CertExpiryAlert): Promise<boolean>;
}
