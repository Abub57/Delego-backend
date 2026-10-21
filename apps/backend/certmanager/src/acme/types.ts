import type { AcmeProvider, ChallengeType, DnsProviderConfig } from "@delegolabs/types";

export interface AcmeChallenge {
  type: ChallengeType;
  domain: string;
  /** The DNS TXT value (dns-01) or HTTP resource body (http-01). */
  value: string;
  /** For wildcard the affected zone root. */
  targetDomain: string;
  /** The ACME challenge token — the http-01 URL path segment. */
  token?: string;
}

export interface AcmeClient {
  readonly provider: AcmeProvider;
  readonly directoryUrl: string;
  issue(input: IssueInput): Promise<AcmeIssueResult>;
  revoke(serialNumber: string, reason: RevocationReason): Promise<void>;
}

export interface IssueInput {
  domains: string[];
  challengeType: ChallengeType;
  wildcardEnabled: boolean;
  /** Presents a challenge to the world (e.g. creates a DNS TXT record). */
  present: (challenge: AcmeChallenge) => Promise<void>;
  /** Removes the presented challenge. */
  cleanup: (challenge: AcmeChallenge) => Promise<void>;
  /** Returns a freshly generated CSR (PEM) for the requested domains. */
  createCsr: () => Promise<{ csrPem: string; privateKeyPem: string }>;
}

export interface AcmeIssueResult {
  certificatePem: string;
  fullchainPem: string;
  privateKeyPem: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
}

export type RevocationReason =
  | "unspecified"
  | "keyCompromise"
  | "affiliationChanged"
  | "superseded"
  | "cessationOfOperation";

export const ACME_DIRECTORIES: Record<AcmeProvider, string> = {
  letsencrypt: "https://acme-v02.api.letsencrypt.org/directory",
  zerossl: "https://acme.zerossl.com/v2/DV90",
  buypass: "https://api.buypass.com/acme/directory",
  custom: "",
};

export function resolveDirectoryUrl(provider: AcmeProvider, customUrl?: string): string {
  if (provider === "custom") {
    if (!customUrl) throw new Error("custom ACME provider requires CUSTOM_ACME_DIRECTORY_URL");
    return customUrl;
  }
  return ACME_DIRECTORIES[provider];
}

export function validateWildcardSupport(
  domains: string[],
  challengeType: ChallengeType,
  wildcardEnabled: boolean,
): void {
  if (!wildcardEnabled) return;
  if (challengeType !== "dns-01") {
    throw new Error("wildcard certificates require the dns-01 challenge type");
  }
  const hasWildcard = domains.some((d) => d.startsWith("*."));
  if (!hasWildcard) {
    throw new Error("wildcardEnabled is true but no *. domain was provided");
  }
}

export type { DnsProviderConfig };
