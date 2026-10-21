# Delego Backend

<div align="center">

**Backend microservices, agents, and shared SDK for [Delego](https://github.com/DelegoLabs/Delego) — AI-Powered Delegated Commerce on Stellar**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-green)](https://nodejs.org/)

</div>

## 🌟 Overview

This repository contains the backend platform for Delego: the API gateway, orchestration engine, wallet and payments services, AI agents, shared domain types, and the public client SDK. The frontend web application lives in the [Delego](https://github.com/DelegoLabs/Delego) repository and the Soroban smart contracts in [Delego-contracts](https://github.com/DelegoLabs/Delego-contracts).

### 🏗️ Repository Map

| Repository | Purpose |
|---|---|
| [Delego](https://github.com/DelegoLabs/Delego) | Frontend web application (`apps/frontend`), depends on the published `@delegolabs/sdk` and `@delegolabs/types` |
| [Delego-backend](https://github.com/DelegoLabs/Delego-backend) | **This repo** — microservices, agents, shared packages, SDK |
| [Delego-contracts](https://github.com/DelegoLabs/Delego-contracts) | Soroban smart contracts |

```
Delego (web) ──> API Gateway ──> Orchestrator / Wallet / Payments / Notifications
                       │                │
                       │                └──> Agents (buyer-agent, payment-agent)
                       │
                       └──> Soroban Contracts (Delego-contracts) via RPC
```

## 📦 What's Inside

### Services (`apps/backend/`)

| Service | Package | Port | Responsibility |
|---|---|---|---|
| Gateway | `@delegolabs/gateway` | 3000 | Single API entry point: auth (JWT), RBAC, rate limiting, routing |
| Orchestrator | `@delegolabs/orchestrator` | 3010 | Purchase workflow coordination and state machine |
| Wallet | `@delegolabs/wallet` | 3012 | Stellar accounts, Soroban permissions, tx signing/submission |
| Payments | `@delegolabs/payments` | 3014 | Escrow coordination, settlements, refunds |
| Notifications | `@delegolabs/notifications` | 3015 | Email/push notifications with retry (DLQ) |
| Cert Manager | `@delegolabs/certmanager` | 3020 | Automated TLS certificates: ACME issuance, renewal, CT logs, inventory, revocation, deployment |
| DB Vacuum | `@delegolabs/db-vacuum` | 3022 | PostgreSQL bloat monitoring: dead-tuple thresholds, alerts, non-blocking `VACUUM ANALYZE`, worker metrics |

Each service is independently deployable and exposes `GET /health`.

### Agents (`agents/`)

- `buyer-agent/` — searches products, proposes purchases
- `payment-agent/` — executes delegated payments within permission limits

### Shared Packages (`packages/`)

| Package | Purpose | Published |
|---|---|---|
| `@delegolabs/types` | Shared domain types and interfaces | Yes — GitHub Packages |
| `@delegolabs/utils` | Shared utilities | Yes — GitHub Packages |
| `@delegolabs/sdk` | TypeScript client SDK for the Delego API | Yes — GitHub Packages |
| `@delegolabs/cache` | Redis Cluster client config, cache-aside helpers, tag-based invalidation | Yes — GitHub Packages |

These packages are built and published to **GitHub Packages** (`npm.pkg.github.com`) under the `@delegolabs` scope (matching the DelegoLabs org), so the frontend repository can consume them without a monorepo dependency.

**Publishing:** push a `v*` tag (or trigger the `Publish Packages` workflow manually). The [`publish.yml`](./.github/workflows/publish.yml) workflow builds and publishes all three packages.

**Consuming:** add the following to your project's `.npmrc` and install from GitHub Packages (authenticate with a GitHub PAT that has `read:packages`):

```ini
@delegolabs:registry=https://npm.pkg.github.com
```

See [Working with the npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) for auth setup.

### Data & Infra

- `database/` — migrations, schema, seeds
- `infrastructure/` — deployment, docker, monitoring, terraform
- `scripts/` — setup (migrate/seed), deploy, generation helpers
- `tests/` — unit, integration, and e2e test workspaces

## 🛠️ Development

### Prerequisites

- Node.js `>= 20`
- pnpm `>= 9` (`corepack enable`)
- Docker (for local PostgreSQL/Redis via compose)

### Getting Started

```bash
pnpm install
pnpm docker:up        # start PostgreSQL/Redis
pnpm db:migrate       # apply database migrations
pnpm db:seed          # seed development data
pnpm dev              # run all services and agents
```

### Per-Service Commands

```bash
pnpm dev:gateway
pnpm --filter @delegolabs/wallet dev
```

### Building

```bash
pnpm build
```

### Testing

```bash
pnpm test                    # all workspaces
pnpm test:unit               # unit tests
pnpm test:integration        # integration tests
pnpm test:e2e                # end-to-end tests
```

## 📚 Documentation

- [Services overview](./apps/backend/README.md)
- [Architecture](./ARCHITECTURE.md)
- [Operational runbook (DLQ)](./OPERATIONAL_RUNBOOK_DLQ.md)
- [Email retry DLQ design](./DEPLOYMENT_EMAIL_RETRY_DLQ.md)
- [Operational runbook (encryption)](./OPERATIONAL_RUNBOOK_ENCRYPTION.md)
- [PII data catalog](./docs/PII_CATALOG.md)

## 🤝 Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced via commitlint + husky).

---

**Last Updated**: September 2026
