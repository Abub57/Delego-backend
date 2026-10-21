import { afterEach, describe, expect, it } from "vitest";
import {
  DomainVerificationWorker,
  isCnamePointingToEdge,
  isCnamePointingToTarget,
  normalizeDomain,
  type DomainResolver,
} from "./worker.js";
import {
  InMemoryDomainCertificateVault,
  InMemoryDomainVerificationJobSource,
} from "./store/domainCertificateStore.js";
import {
  InMemoryHttp01ChallengeResponder,
  startHttp01ChallengeServer,
  type Http01ChallengeServer,
} from "./acme/http01.js";
import {
  StubAcmeClient,
  type AcmeClient,
  type AcmeIssueResult,
  type IssueInput,
} from "./acme/client.js";
import type { DomainVerificationJobData } from "@delegolabs/types";

class StaticResolver implements DomainResolver {
  constructor(private readonly answers: Record<string, string[] | Error>) {}

  async resolveCname(hostname: string): Promise<string[]> {
    const answer = this.answers[hostname];
    if (answer instanceof Error) throw answer;
    return answer ?? [];
  }
}

class FakeAcmeClient implements AcmeClient {
  readonly provider = "custom" as const;
  readonly directoryUrl = "fake://acme";
  readonly issued: string[] = [];

  async issue(input: IssueInput): Promise<AcmeIssueResult> {
    this.issued.push(input.domains[0]);
    const challenge = {
      type: "http-01" as const,
      domain: input.domains[0],
      value: "token.thumbprint",
      targetDomain: input.domains[0],
      token: "token",
    };
    await input.present(challenge);
    await input.cleanup(challenge);
    return {
      certificatePem: "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----",
      fullchainPem: "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----",
      issuer: "fake",
      serialNumber: "01",
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2026-12-31T00:00:00.000Z",
    };
  }

  async revoke(): Promise<void> {}
}

/** Wraps a client and records what the responder held during the challenge. */
class ChallengeProbeClient implements AcmeClient {
  readonly provider = "custom" as const;
  readonly directoryUrl = "probe://acme";
  public keyAuthorization?: string;

  constructor(
    private readonly inner: AcmeClient,
    private readonly responder: InMemoryHttp01ChallengeResponder,
  ) {}

  async issue(input: IssueInput): Promise<AcmeIssueResult> {
    return this.inner.issue({
      ...input,
      present: async (challenge) => {
        await input.present(challenge);
        this.keyAuthorization = this.responder.getKeyAuthorization(challenge.token ?? "");
      },
    });
  }

  async revoke(): Promise<void> {}
}

function makeJob(overrides: Partial<DomainVerificationJobData> = {}): DomainVerificationJobData {
  return {
    merchantId: "merchant_1",
    customDomain: "shop.merchant.com",
    targetCname: "edge.delego.io",
    ...overrides,
  };
}

function makeWorker(options: {
  resolver?: DomainResolver;
  acmeClient?: AcmeClient;
  responder?: InMemoryHttp01ChallengeResponder;
  jobSource?: InMemoryDomainVerificationJobSource;
  vault?: InMemoryDomainCertificateVault;
} = {}) {
  return new DomainVerificationWorker({
    jobSource: options.jobSource ?? new InMemoryDomainVerificationJobSource(),
    vault: options.vault ?? new InMemoryDomainCertificateVault(),
    resolver: options.resolver ?? new StaticResolver({}),
    acmeClient: options.acmeClient ?? new FakeAcmeClient(),
    responder: options.responder ?? new InMemoryHttp01ChallengeResponder(),
    edgeCnameTargets: ["edge.delego.io"],
    renewBeforeDays: 30,
  });
}

describe("CNAME matching", () => {
  it("normalizes trailing dots and casing", () => {
    expect(normalizeDomain("Edge.Delego.IO.")).toBe("edge.delego.io");
  });

  it("accepts an exact target and per-merchant edge subdomains", () => {
    expect(isCnamePointingToTarget(["edge.delego.io."], "edge.delego.io")).toBe(true);
    expect(isCnamePointingToTarget(["m_123.edge.delego.io"], "edge.delego.io")).toBe(true);
  });

  it("rejects unrelated hosts and lookalike suffixes", () => {
    expect(isCnamePointingToTarget(["evil.example.com"], "edge.delego.io")).toBe(false);
    expect(isCnamePointingToTarget(["notedge.delego.io"], "edge.delego.io")).toBe(false);
  });

  it("requires the CNAME to fall under a configured Delego edge zone", () => {
    expect(isCnamePointingToEdge(["m_1.edge.delego.io"], ["edge.delego.io"])).toBe(true);
    expect(isCnamePointingToEdge(["shop.hosted.example"], ["edge.delego.io"])).toBe(false);
    expect(isCnamePointingToEdge(["edge.delego.io"], [])).toBe(false);
  });
});

describe("DomainVerificationWorker.verifyDomain", () => {
  it("verifies a custom domain pointing at the Delego edge", async () => {
    const worker = makeWorker({
      resolver: new StaticResolver({ "shop.merchant.com": ["m_1.edge.delego.io."] }),
    });

    const result = await worker.verifyDomain(makeJob());

    expect(result.verified).toBe(true);
    expect(result.resolvedCnames).toEqual(["m_1.edge.delego.io."]);
  });

  it("keeps a job pending while the CNAME has not propagated", async () => {
    const worker = makeWorker({
      resolver: new StaticResolver({ "shop.merchant.com": ["shop.merchant.com.evil.test"] }),
    });

    const result = await worker.verifyDomain(makeJob());

    expect(result.verified).toBe(false);
    expect(result.reason).toBe("cname_mismatch");
  });

  it("reports a missing CNAME record", async () => {
    const err = Object.assign(new Error("queryCname ENODATA"), { code: "ENODATA" });
    const worker = makeWorker({
      resolver: new StaticResolver({ "shop.merchant.com": err }),
    });

    const result = await worker.verifyDomain(makeJob());

    expect(result.verified).toBe(false);
    expect(result.reason).toBe("no_cname_record");
  });

  it("surfaces transient DNS errors without a verdict", async () => {
    const err = Object.assign(new Error("queryCname ESERVFAIL"), { code: "ESERVFAIL" });
    const worker = makeWorker({
      resolver: new StaticResolver({ "shop.merchant.com": err }),
    });

    const result = await worker.verifyDomain(makeJob());

    expect(result.verified).toBe(false);
    expect(result.reason).toBe("dns_error");
    expect(result.error).toMatch(/ESERVFAIL/);
  });

  it("rejects a target that is not a Delego edge hostname", async () => {
    const worker = makeWorker({
      resolver: new StaticResolver({ "shop.merchant.com": ["attacker.example.com"] }),
    });

    const result = await worker.verifyDomain(
      makeJob({ targetCname: "attacker.example.com" }),
    );

    expect(result.verified).toBe(false);
    expect(result.reason).toBe("not_delego_edge");
  });
});

describe("DomainVerificationWorker.provisionCertificate", () => {
  it("completes the http-01 challenge and stores encrypted PEMs", async () => {
    const responder = new InMemoryHttp01ChallengeResponder();
    const vault = new InMemoryDomainCertificateVault();
    const probe = new ChallengeProbeClient(new StubAcmeClient(), responder);
    const worker = makeWorker({ acmeClient: probe, responder, vault });

    const result = await worker.provisionCertificate(makeJob());

    expect(probe.keyAuthorization).toBe("stub-challenge-token");
    expect(responder.size).toBe(0); // challenge cleaned up after issuance
    expect(result.domain).toBe("shop.merchant.com");
    expect(result.certificatePem).toContain("BEGIN CERTIFICATE");
    expect(result.privateKeyPem).toContain("PRIVATE KEY");
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(result.renewBefore).getTime()).toBeLessThan(new Date(result.expiresAt).getTime());

    const stored = vault.records.get("merchant_1:shop.merchant.com");
    expect(stored).toBeDefined();
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("BEGIN CERTIFICATE");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(stored?.certificatePem.algorithm).toBe("AES-256-GCM");

    await expect(vault.get("merchant_1", "shop.merchant.com")).resolves.toEqual(result);
  });

  it("rejects wildcard custom domains before contacting ACME", async () => {
    const acme = new FakeAcmeClient();
    const worker = makeWorker({ acmeClient: acme });

    await expect(
      worker.provisionCertificate(makeJob({ customDomain: "*.merchant.com" })),
    ).rejects.toThrow(/wildcard/);
    expect(acme.issued).toHaveLength(0);
  });
});

describe("DomainVerificationWorker.runCycle", () => {
  it("provisions verified domains and leaves unpropagated ones pending", async () => {
    const jobSource = new InMemoryDomainVerificationJobSource([
      makeJob({ merchantId: "merchant_1", customDomain: "shop.merchant.com" }),
      makeJob({ merchantId: "merchant_2", customDomain: "store.other.com" }),
    ]);
    const vault = new InMemoryDomainCertificateVault();
    const acme = new FakeAcmeClient();
    const worker = makeWorker({
      jobSource,
      vault,
      acmeClient: acme,
      resolver: new StaticResolver({
        "shop.merchant.com": ["m_1.edge.delego.io"],
        "store.other.com": ["pending.example.com"],
      }),
    });

    const summary = await worker.runCycle();

    expect(summary).toMatchObject({
      checked: 2,
      verified: 1,
      provisioned: 1,
      pending: 1,
      failed: 0,
    });
    expect(acme.issued).toEqual(["shop.merchant.com"]);

    const pending = await jobSource.listPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].customDomain).toBe("store.other.com");
    expect(pending[0].lastError).toContain("cname_mismatch");
    expect(pending[0].attempts).toBe(1);

    const result = await vault.get("merchant_1", "shop.merchant.com");
    expect(result?.renewBefore).toBe("2026-12-01T00:00:00.000Z");
  });

  it("keeps the job pending when ACME issuance fails", async () => {
    class FailingAcmeClient extends FakeAcmeClient {
      async issue(): Promise<AcmeIssueResult> {
        throw new Error("ACME rate limited");
      }
    }

    const jobSource = new InMemoryDomainVerificationJobSource([makeJob()]);
    const worker = makeWorker({
      jobSource,
      acmeClient: new FailingAcmeClient(),
      resolver: new StaticResolver({ "shop.merchant.com": ["edge.delego.io"] }),
    });

    const summary = await worker.runCycle();

    expect(summary.failed).toBe(1);
    expect(summary.provisioned).toBe(0);
    expect(summary.errors[0].error).toMatch(/rate limited/);
    expect((await jobSource.listPending(10))[0].lastError).toMatch(/rate limited/);
  });
});

describe("http-01 challenge responder", () => {
  let server: Http01ChallengeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("serves the key authorization for a pending token", async () => {
    const responder = new InMemoryHttp01ChallengeResponder();
    await responder.present({
      domain: "shop.merchant.com",
      token: "abc123",
      keyAuthorization: "abc123.thumbprint",
    });
    server = await startHttp01ChallengeServer(responder, { host: "127.0.0.1", port: 0 });
    const port = (server.server.address() as { port: number }).port;

    const found = await fetch(`http://127.0.0.1:${port}/.well-known/acme-challenge/abc123`);
    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toContain("text/plain");
    await expect(found.text()).resolves.toBe("abc123.thumbprint");

    const missing = await fetch(`http://127.0.0.1:${port}/.well-known/acme-challenge/nope`);
    expect(missing.status).toBe(404);

    await responder.cleanup({
      domain: "shop.merchant.com",
      token: "abc123",
      keyAuthorization: "abc123.thumbprint",
    });
    const cleaned = await fetch(`http://127.0.0.1:${port}/.well-known/acme-challenge/abc123`);
    expect(cleaned.status).toBe(404);
  });
});
