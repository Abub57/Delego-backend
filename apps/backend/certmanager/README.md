# @delegolabs/certmanager

Automated TLS certificate management for the Delego backend.

## Responsibilities

- **ACME integration** — issue certificates against Let's Encrypt, ZeroSSL, Buypass
  or a custom ACME directory (`CERT_ACME_PROVIDER`, `CERT_ACME_MODE=stub|http`).
- **Automatic renewal** — `RenewalScheduler` renews certificates when
  `nextRenewalAt` (computed as `notAfter - renewBeforeDays`) is reached. Defaults
  to renewing 30 days before expiry.
- **Certificate Transparency** — every issued certificate is submitted to the
  configured CT logs (`CERT_CT_LOG_URLS`).
- **Inventory & monitoring** — `GET /api/v1/certificates` lists the live inventory
  with recomputed status (`valid` / `expiring` / `expired` / `revoked` / `pending`)
  and `GET /api/v1/certificates/metrics` exposes `CertificateMetrics`.
- **Wildcard support** — wildcard domains require the `dns-01` challenge; the
  configured DNS provider (`cloudflare`, `route53`, `azure`, `google`) presents
  and cleans up the `_acme-challenge` TXT record.
- **Revocation** — `POST /api/v1/certificates/:id/revoke` revokes a certificate
  via the ACME client and marks it `revoked`.
- **Deployment automation** — issued/renewed certificates can be deployed to
  `nginx`, `haproxy`, `envoy` (PEM files) or a `webhook` target.
- **Merchant custom domains** — the domain worker resolves each custom domain's
  CNAME with `node:dns/promises`, confirms it points at a Delego edge hostname,
  then completes the Let's Encrypt `http-01` challenge and stores the issued
  certificate and private key AES-256-GCM encrypted.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CERTMANAGER_PORT` | `3020` | HTTP port |
| `CERT_ACME_MODE` | `stub` | `stub` (self-signed, offline) or `http` (real ACME) |
| `CERT_ACME_PROVIDER` | – | `letsencrypt` / `zerossl` / `buypass` / `custom` |
| `CERT_CT_ENABLED` | `true` | Submit certificates to CT logs |
| `CERT_CT_LOG_URLS` | Google + Cloudflare logs | Comma-separated CT log base URLs |
| `CERT_RENEWAL_INTERVAL_MS` | `43200000` | Scheduler interval (12h) |
| `CERT_RENEWAL_ENABLED` | `true` | Run the background renewal scheduler |
| `CERT_STORE` | `memory` | `memory` or `postgres` |
| `CERT_DOMAIN_WORKER_ENABLED` | `false` | Run the custom-domain verification worker (needs PostgreSQL) |
| `CERT_DOMAIN_WORKER_INTERVAL_MS` | `300000` | Domain verification cycle interval (5m) |
| `CERT_DOMAIN_WORKER_BATCH_SIZE` | `25` | Jobs processed per cycle |
| `CERT_EDGE_CNAME_TARGETS` | `edge.delego.io` | Comma-separated edge hostnames a CNAME must resolve under |
| `CERT_DNS_TIMEOUT_MS` | `5000` | CNAME lookup timeout |
| `CERT_HTTP01_SERVE` | `true` | Serve `/.well-known/acme-challenge/` for the edge to proxy |
| `CERT_HTTP01_HOST` / `CERT_HTTP01_PORT` | `0.0.0.0` / `8089` | Challenge responder bind address |
| `CERT_PEM_ENCRYPTION_KEY` | – | 32-byte key (hex/base64) encrypting certificate PEMs; required in production |
| `CERT_RENEW_BEFORE_DAYS` | `30` | Days before expiry recorded as `renewBefore` |

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health`, `/health/ready`, `/health/metrics` | Health probes |
| `GET` | `/api/v1/certificates` | Certificate inventory |
| `POST` | `/api/v1/certificates` | Issue a certificate |
| `GET` | `/api/v1/certificates/:id` | Certificate detail |
| `POST` | `/api/v1/certificates/:id/renew` | Renew a certificate |
| `POST` | `/api/v1/certificates/:id/revoke` | Revoke a certificate |
| `POST` | `/api/v1/certificates/renewals` | Trigger due renewals |
| `GET` | `/api/v1/certificates/metrics` | Monitoring metrics |

## Merchant custom-domain worker

When `CERT_DOMAIN_WORKER_ENABLED=true`, the worker polls
`domain_verification_jobs` for pending merchant domains. For each job it:

1. calls `dns.resolveCname(customDomain)` (bounded by `CERT_DNS_TIMEOUT_MS`),
2. requires the answer to match `targetCname` and, when configured, one of the
   `CERT_EDGE_CNAME_TARGETS` edge zones — otherwise the job stays pending and
   is retried next cycle (DNS propagation),
3. issues a Let's Encrypt certificate through the ACME client using `http-01`.
   The challenge response is served by the built-in responder on
   `CERT_HTTP01_PORT`; route `/.well-known/acme-challenge/*` for merchant
   domains to that port from the edge,
4. encrypts `certificatePem` and `privateKeyPem` with AES-256-GCM and upserts
   them into `domain_certificates`, then marks the job completed.

`AcmeCertProvisionResult` is the returned/stored shape (`domain`,
`certificatePem`, `privateKeyPem`, `expiresAt`, `renewBefore`).

## Running

```bash
pnpm --filter @delegolabs/certmanager dev
pnpm --filter @delegolabs/certmanager test
```
