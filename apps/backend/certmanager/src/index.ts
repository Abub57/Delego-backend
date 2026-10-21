/**
 * @delegolabs/certmanager — Automated TLS certificate management.
 *
 * Responsibilities:
 *   - ACME issuance (Let's Encrypt, ZeroSSL, Buypass, custom)
 *   - Automatic renewal before expiry
 *   - Certificate Transparency log submission
 *   - Certificate inventory + monitoring/metrics
 *   - Wildcard certificate support (dns-01)
 *   - Certificate revocation
 *   - Deployment automation (nginx/haproxy/envoy/webhook)
 *   - Merchant custom-domain CNAME verification + http-01 provisioning
 */
import { createLogger, createHealthRoutes, startHttpServer, HealthRegistry } from "@delegolabs/utils";
import { createAcmeClient } from "./acme/client.js";
import { createCertificateStore } from "./store/certificateStore.js";
import { createCtLogSubmitter } from "./ct/ctLog.js";
import { createDeployer } from "./deploy/deployer.js";
import { CertificateService } from "./service.js";
import { RenewalScheduler } from "./renewal/scheduler.js";
import { registerRoutes } from "./routes/index.js";
import {
  InMemoryHttp01ChallengeResponder,
  startHttp01ChallengeServer,
} from "./acme/http01.js";
import { startDomainVerificationWorker, type DomainVerificationWorker } from "./worker.js";

const SERVICE_NAME = "certmanager";
const DEFAULT_PORT = 3020;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const port = Number(process.env.CERTMANAGER_PORT ?? DEFAULT_PORT);
const log = createLogger(SERVICE_NAME, logLevel);

const store = createCertificateStore();
const ctSubmitter = createCtLogSubmitter({
  enabled: process.env.CERT_CT_ENABLED !== "false",
  logUrls: (process.env.CERT_CT_LOG_URLS ?? "https://ct.googleapis.com/logs/argon2024,https://ct.cloudflare.com/logs/nimbus2024")
    .split(",")
    .filter(Boolean),
});
const deployer = createDeployer();
const service = new CertificateService({ store, ctSubmitter, deployer });

const scheduler = new RenewalScheduler(service, {
  intervalMs: Number(process.env.CERT_RENEWAL_INTERVAL_MS ?? 1000 * 60 * 60 * 12),
  onError: (err) => log.error("renewal tick failed", { error: (err as Error).message }),
});

// Warm the ACME client factory so misconfiguration fails fast at boot.
if (process.env.CERT_ACME_PROVIDER) {
  createAcmeClient({
    provider: process.env.CERT_ACME_PROVIDER as any,
    accountKey: process.env.CERT_ACME_ACCOUNT_KEY ?? "",
    mode: process.env.CERT_ACME_MODE as any,
  });
}

const healthRegistry = new HealthRegistry();
healthRegistry.register(
  "store",
  async () => {
    await store.list();
    return { status: "healthy" };
  },
  { type: "custom", critical: true },
);
const health = createHealthRoutes({
  registry: healthRegistry,
  serviceName: SERVICE_NAME,
  version: "0.0.1",
});

log.info("Starting certmanager", { port, nodeEnv });

startHttpServer({
  port,
  serviceName: SERVICE_NAME,
  version: "0.0.1",
  routes: [...health, ...registerRoutes(service)],
});

if (process.env.CERT_RENEWAL_ENABLED !== "false") {
  scheduler.start();
}

// Merchant custom-domain verification + Let's Encrypt http-01 provisioning.
// Off by default because it needs PostgreSQL and an ACME account key.
const challengeResponder = new InMemoryHttp01ChallengeResponder();
let domainWorker: DomainVerificationWorker | undefined;

if (process.env.CERT_DOMAIN_WORKER_ENABLED === "true") {
  domainWorker = startDomainVerificationWorker({ responder: challengeResponder, log });

  if (process.env.CERT_HTTP01_SERVE !== "false") {
    void startHttp01ChallengeServer(challengeResponder)
      .then((server) => log.info("http-01 challenge server listening", { url: server.url }))
      .catch((err) =>
        log.error("http-01 challenge server failed to start", {
          error: (err as Error).message,
        }),
      );
  }
}

export { service, scheduler, domainWorker, challengeResponder };
