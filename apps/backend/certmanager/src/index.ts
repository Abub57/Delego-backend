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
 *   - Merchant custom-domain CNAME verification + http-01 provisioning (#597)
 *   - Merchant storefront SSL/TLS expiry monitoring (Issue #390)
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
  RotatingStorageClient,
  StorageRotationScheduler,
  StorageRotationService,
} from "./storage/index.js";
import { registerStorageRotationRoutes } from "./storage/routes.js";
import type { StorageObjectStore } from "./storage/index.js";
import { registerCertExpiryRoutes } from "./routes/certExpiryRoutes.js";
import { CertExpiryChecker } from "./expiry/checker.js";
import { ExpiryScheduler } from "./expiry/scheduler.js";
import { createCertExpiryAlerter } from "./expiry/alerter.js";
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

// Issue #390 — automated SSL/TLS certificate expiry checking for merchant
// storefronts: probe each registered custom domain and alert 14 days before
// expiration.
const expiryChecker = new CertExpiryChecker({
  alerter: createCertExpiryAlerter({
    webhookUrl: process.env.CERT_EXPIRY_WEBHOOK_URL,
  }),
  warningDays: Number(process.env.CERT_EXPIRY_WARNING_DAYS ?? 14),
  probe: {
    timeoutMs: Number(process.env.CERT_EXPIRY_PROBE_TIMEOUT_MS ?? 10_000),
    port: Number(process.env.CERT_EXPIRY_PROBE_PORT ?? 443),
  },
});

// Seed monitored domains from a JSON env var:
//   [{ "merchantId": "m1", "domain": "shop.example.com" }, ...]
try {
  if (process.env.CERT_EXPIRY_DOMAINS) {
    expiryChecker.registerDomains(JSON.parse(process.env.CERT_EXPIRY_DOMAINS));
    log.info("registered merchant domains for expiry monitoring", {
      count: expiryChecker.listDomains().length,
    });
  }
} catch (err) {
  log.error("invalid CERT_EXPIRY_DOMAINS payload — expiry monitoring starts empty", {
    error: (err as Error).message,
  });
}

const expiryScheduler = new ExpiryScheduler(expiryChecker, {
  intervalMs: Number(process.env.CERT_EXPIRY_INTERVAL_MS ?? 1000 * 60 * 60 * 12),
  onError: (err) => log.error("expiry check tick failed", { error: (err as Error).message }),
});

log.info("Starting certmanager", { port, nodeEnv });

// ─── Object-storage key rotation (#400) ────────────────────────────────────
// Dual-credential R2/S3 key rotation every 90 days with zero downtime.
// Enabled only when STORAGE_PRIMARY_KEY_ID is configured; a single injectable
// store keeps the data-plane decoupled and lets tests stub the provider.
const storageBindingId = process.env.STORAGE_BINDING_ID ?? "r2:delego-uploads";
const storageProvider = (storageBindingId.split(":")[0] === "s3" ? "s3" : "r2") as "r2" | "s3";
const rotatingStore: StorageObjectStore = {
  verify: async () => {
    /* HEAD bucket — wired to the S3 client by deployment config */
  },
  execute: async (_key, operation) => operation.run({
    primaryKeyId: process.env.STORAGE_PRIMARY_KEY_ID ?? "",
    primarySecret: process.env.STORAGE_PRIMARY_SECRET ?? "",
  }),
};
const rotatingClient = new RotatingStorageClient(
  {
    bindingId: storageBindingId,
    provider: storageProvider,
    bucket: process.env.STORAGE_BUCKET_NAME ?? "delego-uploads",
    credentials: {
      primaryKeyId: process.env.STORAGE_PRIMARY_KEY_ID ?? "",
      primarySecret: process.env.STORAGE_PRIMARY_SECRET ?? "",
      ...(process.env.STORAGE_SECONDARY_KEY_ID && process.env.STORAGE_SECONDARY_SECRET
        ? {
            secondaryKeyId: process.env.STORAGE_SECONDARY_KEY_ID,
            secondarySecret: process.env.STORAGE_SECONDARY_SECRET,
          }
        : {}),
    },
    ...(process.env.STORAGE_PRIMARY_EXPIRES_AT
      ? { primaryExpiresAt: process.env.STORAGE_PRIMARY_EXPIRES_AT }
      : {}),
    ...(process.env.STORAGE_SECONDARY_EXPIRES_AT
      ? { secondaryExpiresAt: process.env.STORAGE_SECONDARY_EXPIRES_AT }
      : {}),
  },
  rotatingStore,
);
const storageRotationService = new StorageRotationService(
  rotatingClient,
  {
    // Real deployments wire this to the R2/S3 control-plane API (R2
    // CreateToken/DeleteToken, IAM CreateAccessKey/DeleteAccessKey).
    createKey: async () => ({
      keyId: process.env.STORAGE_INCOMING_KEY_ID ?? "",
      secret: process.env.STORAGE_INCOMING_SECRET ?? "",
    }),
    revokeKey: async () => {
      /* provider revocation wired by deployment config */
    },
  },
  { bindingId: storageBindingId, provider: storageProvider, bucket: process.env.STORAGE_BUCKET_NAME ?? "delego-uploads" },
  {
    rotationDays: Number(process.env.STORAGE_ROTATION_DAYS ?? 90),
    gracePeriodMs: Number(process.env.STORAGE_ROTATION_GRACE_MS ?? 1000 * 60 * 60 * 24),
    alertOptions: {
      warnDays: Number(process.env.STORAGE_KEY_WARN_DAYS ?? 14),
      criticalDays: Number(process.env.STORAGE_KEY_CRITICAL_DAYS ?? 7),
    },
  });
const storageRotationScheduler = new StorageRotationScheduler(storageRotationService, {
  intervalMs: Number(process.env.STORAGE_ROTATION_INTERVAL_MS ?? 1000 * 60 * 60),
});
const storageRotationEnabled = Boolean(process.env.STORAGE_PRIMARY_KEY_ID);
if (storageRotationEnabled) {
  storageRotationScheduler.start();
  log.info("storage key rotation enabled", { bindingId: storageBindingId });
} else {
  log.info("storage key rotation disabled (STORAGE_PRIMARY_KEY_ID not set)");
}

startHttpServer({
  port,
  serviceName: SERVICE_NAME,
  version: "0.0.1",
  routes: [
    ...health,
    ...registerRoutes(service),
    ...registerStorageRotationRoutes(storageRotationService),
    ...registerCertExpiryRoutes(expiryChecker),
  ],
});

if (process.env.CERT_RENEWAL_ENABLED !== "false") {
  scheduler.start();
}

if (process.env.CERT_EXPIRY_ENABLED !== "false") {
  expiryScheduler.start();
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

export {
  service,
  scheduler,
  storageRotationService,
  storageRotationScheduler,
  expiryChecker,
  expiryScheduler,
  domainWorker,
  challengeResponder,
};
