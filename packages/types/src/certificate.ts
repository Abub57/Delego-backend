/**
 * TLS certificate management domain types.
 */

export type AcmeProvider = "letsencrypt" | "zerossl" | "buypass" | "custom";
export type ChallengeType = "http-01" | "dns-01" | "tls-alpn-01";
export type DnsProviderType = "cloudflare" | "route53" | "azure" | "google";

export interface DnsProviderConfig {
  type: DnsProviderType;
  credentials: Record<string, string>;
}

export interface CertificateConfig {
  domains: string[];
  acmeProvider: AcmeProvider;
  acmeAccountKey: string;
  challengeType: ChallengeType;
  dnsProvider?: DnsProviderConfig;
  renewBeforeDays: number;
  wildcardEnabled: boolean;
}

export type CertificateStatus =
  | "valid"
  | "expiring"
  | "expired"
  | "revoked"
  | "pending";

export interface Certificate {
  id: string;
  domains: string[];
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  status: CertificateStatus;
  autoRenew: boolean;
  lastRenewalAttempt?: string;
  nextRenewalAt: string;
}

export interface CertificateMetrics {
  totalCertificates: number;
  expiringSoon: number;
  expired: number;
  renewalSuccessRate: number;
  avgRenewalTimeMs: number;
  failedRenewals: number;
}

export interface IssuedCertificate {
  domains: string[];
  certificatePem: string;
  privateKeyPem: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
}

export type DeploymentTarget =
  | "nginx"
  | "haproxy"
  | "envoy"
  | "webhook";

export type RevocationReason =
  | "unspecified"
  | "keyCompromise"
  | "affiliationChanged"
  | "superseded"
  | "cessationOfOperation";

export interface DeploymentConfig {
  target: DeploymentTarget;
  /** Arbitrary target-specific options (paths, endpoints, secrets). */
  options?: Record<string, string>;
}

export interface CtLogResult {
  logUrl: string;
  submittedAt: string;
  sct?: string;
}

/**
 * #597 — A merchant custom-domain verification job consumed by the certmanager
 * background worker. The merchant points `customDomain` at `targetCname` (a
 * Delego edge hostname); the worker verifies propagation before issuing a
 * certificate via the ACME http-01 challenge.
 */
export interface DomainVerificationJobData {
  merchantId: string;
  customDomain: string;
  targetCname: string;
}

/** Result of a successful Let's Encrypt certificate provisioning run. */
export interface AcmeCertProvisionResult {
  domain: string;
  certificatePem: string;
  privateKeyPem: string;
  expiresAt: string;
  renewBefore: string;
}
