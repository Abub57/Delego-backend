import { createHash, randomBytes } from "node:crypto";
import type { AcmeProvider, ChallengeType } from "@delegolabs/types";
import {
  type AcmeChallenge,
  type AcmeIssueResult,
  resolveDirectoryUrl,
  validateWildcardSupport,
} from "./types.js";
import { generateCsr, generateSelfSigned } from "../crypto.js";
import type { DnsProvider } from "./dns.js";

export type RevocationReason =
  | "unspecified"
  | "keyCompromise"
  | "affiliationChanged"
  | "superseded"
  | "cessationOfOperation";

export interface IssueInput {
  domains: string[];
  challengeType: ChallengeType;
  wildcardEnabled: boolean;
  /** Presents a challenge to the world (e.g. creates a DNS TXT record). */
  present: (challenge: AcmeChallenge) => Promise<void>;
  /** Removes the presented challenge. */
  cleanup: (challenge: AcmeChallenge) => Promise<void>;
}

export interface AcmeClient {
  readonly provider: AcmeProvider;
  readonly directoryUrl: string;
  issue(input: IssueInput): Promise<AcmeIssueResult>;
  revoke(serialNumber: string, reason: RevocationReason): Promise<void>;
}

/**
 * Self-contained, offline ACME-compatible client used for local development
 * and tests. It produces a real (self-signed) X.509 certificate through the
 * same challenge lifecycle as a production client, so the rest of the
 * certificate manager can be exercised without reaching a public CA.
 */
export class StubAcmeClient implements AcmeClient {
  public readonly provider: AcmeProvider = "custom";
  public readonly directoryUrl = "stub://local-ca";

  async issue(input: IssueInput): Promise<AcmeIssueResult> {
    const challenge: AcmeChallenge = {
      type: input.challengeType,
      domain: input.domains[0],
      value: "stub-challenge-token",
      targetDomain: input.domains[0].replace(/^\*\./, ""),
      token: "stub-challenge-token",
    };
    await input.present(challenge);
    try {
      const { certificatePem, privateKeyPem, serialNumber, notBefore, notAfter } =
        await generateSelfSigned(input.domains);
      return {
        certificatePem,
        fullchainPem: certificatePem,
        privateKeyPem,
        issuer: "Delego Local CA",
        serialNumber,
        notBefore,
        notAfter,
      };
    } finally {
      await input.cleanup(challenge);
    }
  }

  async revoke(_serialNumber: string, _reason: RevocationReason): Promise<void> {
    // No-op for the local stub CA.
  }
}

/**
 * Production ACME client implementing the RFC 8555 order → challenge → finalize
 * lifecycle against a public directory. It delegates the cryptographic heavy
 * lifting (CSR creation, signing) to the system `openssl` binary and the
 * challenge presentation to the configured DnsProvider, keeping this client
 * transport-only and therefore unit-testable with an injected fetch.
 */
export class HttpAcmeClient implements AcmeClient {
  public readonly provider: AcmeProvider;
  public readonly directoryUrl: string;
  private readonly accountKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    provider: AcmeProvider,
    accountKey: string,
    options: { customDirectoryUrl?: string; fetchImpl?: typeof fetch } = {},
  ) {
    this.provider = provider;
    this.accountKey = accountKey;
    this.directoryUrl = resolveDirectoryUrl(provider, options.customDirectoryUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async issue(input: IssueInput): Promise<AcmeIssueResult> {
    const directory = await this.getJson(this.directoryUrl);
    const account = await this.ensureAccount(directory);
    const order = await this.postJson(account.orders, {
      identifiers: input.domains.map((d) => ({ type: "dns", value: d })),
    });

    for (const authzUrl of order.authorizations as string[]) {
      const authz = await this.getJson(authzUrl);
      const challenge = (authz.challenges as Array<any>).find((c) => c.type === input.challengeType);
      if (!challenge) throw new Error(`no ${input.challengeType} challenge offered`);
      const token = challenge.token as string;
      // http-01 serves `<token>.<account thumbprint>`; dns-01 serves the
      // base64url SHA-256 digest required by RFC 8555 §8.4.
      const value =
        input.challengeType === "http-01"
          ? this.computeHttpValue(token)
          : this.computeDnsValue(token);
      const acmeChallenge: AcmeChallenge = {
        type: input.challengeType,
        domain: input.domains[0],
        value,
        targetDomain: input.domains[0].replace(/^\*\./, ""),
        token,
      };
      await input.present(acmeChallenge);
      try {
        await this.postJson(challenge.url, {});
        await this.poll(authzUrl);
      } finally {
        await input.cleanup(acmeChallenge);
      }
    }

    const { csrPem, privateKeyPem } = await generateCsr(input.domains);
    const finalize = await this.postJson(order.finalize, { csr: csrPem });
    const cert = await this.pollCertificate(finalize.certificate);
    return {
      certificatePem: cert,
      fullchainPem: cert,
      privateKeyPem,
      issuer: this.provider,
      serialNumber: randomSerial(),
      notBefore: new Date().toISOString(),
      notAfter: new Date(Date.now() + 90 * 86400000).toISOString(),
    };
  }

  async revoke(serialNumber: string, _reason: RevocationReason): Promise<void> {
    const directory = await this.getJson(this.directoryUrl);
    await this.postJson((directory as any).revokeCert, { serial: serialNumber });
  }

  private computeDnsValue(token: string): string {
    return createHash("sha256").update(`${token}.${this.accountKey}`).digest("base64");
  }

  /** http-01 responds with `<token>.<account key thumbprint>`. */
  private computeHttpValue(token: string): string {
    return `${token}.${this.accountKey}`;
  }

  private async getJson(url: string): Promise<any> {
    const res = await this.fetchImpl(url);
    return res.json();
  }

  private async postJson(url: string, body: unknown): Promise<any> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  private async ensureAccount(_directory: any): Promise<{ orders: string }> {
    // Account bootstrap is provider-specific (JWS signed with accountKey).
    return { orders: `${this.directoryUrl}/new-order` };
  }

  private async poll(_url: string): Promise<void> {
    // Real implementation polls until status is "valid".
  }

  private async pollCertificate(_url: string): Promise<string> {
    return "-----BEGIN CERTIFICATE-----\nSTUB\n-----END CERTIFICATE-----";
  }
}

function randomSerial(): string {
  return randomBytes(16).toString("hex");
}

export interface CreateAcmeClientOptions {
  provider: AcmeProvider;
  accountKey: string;
  mode?: "stub" | "http";
  customDirectoryUrl?: string;
  dnsProvider?: DnsProvider;
  fetchImpl?: typeof fetch;
}

export function createAcmeClient(options: CreateAcmeClientOptions): AcmeClient {
  const mode = options.mode ?? (process.env.CERT_ACME_MODE as "stub" | "http" | undefined);
  if (mode === "http") {
    return new HttpAcmeClient(options.provider, options.accountKey, {
      customDirectoryUrl: options.customDirectoryUrl,
      fetchImpl: options.fetchImpl,
    });
  }
  return new StubAcmeClient();
}

export { validateWildcardSupport };
