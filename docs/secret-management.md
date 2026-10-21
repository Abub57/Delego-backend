# Secret Management (#81)

How secrets are scanned for, how a detected leak should be handled, and how to rotate a credential once it's exposed.

## Scanning

Every push and pull request to `main` runs [Gitleaks](https://github.com/gitleaks/gitleaks) (`.github/workflows/secret-scan.yml`) against the full commit range being pushed — not just the working tree — so a secret introduced two commits ago and later "removed" is still caught.

Configuration:

- **`.gitleaks.toml`** — extends Gitleaks' default rule set (600+ patterns: AWS/GCP/GitHub/Stripe keys, private keys, generic high-entropy strings) with repo-specific allowlist paths (`.env.example`, docs, test files) that intentionally contain secret-*shaped* placeholder text.
- **`.gitleaksignore`** — fingerprinted suppressions for specific confirmed false positives (e.g. code that constructs a PEM header string literal rather than embedding a real key). Each entry is a single finding's fingerprint, not a broad exemption, so a genuine secret added later to the same file or line range is still caught.

Any push/PR containing a real finding fails the `Secret Scan` check and blocks merge.

## If a secret is detected

1. **Do not just delete the line and push a fix.** The secret is still live in git history and, until rotated, still valid. Treat it as compromised the moment it's committed, even to a branch that never merges.
2. **Rotate the credential immediately** at its source (see the per-credential-type table below) — this invalidates the leaked value regardless of whether it's ever scrubbed from history.
3. **Update the deployment's env var** (wherever `.env`/the deployment's secret store is configured — see `.env.example` for the full list of vars this repo reads) with the new value.
4. Only after rotation, clean the leaked value from git history if the repository's threat model requires it (`git filter-repo` or BFG Repo-Cleaner — coordinate with a maintainer before rewriting shared history).
5. If the finding is a false positive (not a real secret), do not just delete the code — add a fingerprinted entry to `.gitleaksignore` with a one-line comment explaining why, following the existing entries' format. Never widen `.gitleaks.toml`'s allowlist paths/regexes to suppress a single false positive; that weakens the scan for every other file matching the same pattern.

## Rotation procedure by credential type

| Variable(s) | Where to rotate | Notes |
| --- | --- | --- |
| `JWT_SECRET` | Generate a new value (`openssl rand -base64 48`), set in the deployment env | Only used as the HS256 fallback (`apps/backend/gateway/src/auth/tokenKeys.ts`); rotating it invalidates every HS256-signed token immediately, no overlap window. The default `RS256`/`ES256` algorithms *do* support zero-downtime rotation via `JWT_KEY_ROTATION_DAYS` (the active key signs new tokens while retired keys keep verifying until they expire) — prefer that path over HS256 in any environment where signing-key rotation needs to be non-disruptive |
| `WALLET_MASTER_SECRET`, `WALLET_MASTER_SECRET_V1`/`_V2`, `WALLET_SIGNER_SECRET` | Depends on `WALLET_KEY_SIGNER_PROVIDER` — `local` means the env var itself is the key material; a KMS/HSM provider means rotate at the provider | `apps/backend/wallet/src/vault.ts` already reads `WALLET_ACTIVE_KEY_VERSION` and versioned `WALLET_MASTER_SECRET_<VERSION>` vars — set the new secret under the next version, then bump `WALLET_ACTIVE_KEY_VERSION` once it's deployed everywhere that needs to verify it |
| `VAULT_TOKEN` | Rotate in HashiCorp Vault (or whichever secrets backend is configured) | Not yet wired to a live Vault instance in this repo as of #81 — placeholder for when it is |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Provider dashboard (OpenAI/Anthropic account settings) | Revoke the old key at the provider *before* or immediately after rotating the env var, not after — a leaked key is usable until explicitly revoked |
| `SENDGRID_API_KEY` | SendGrid dashboard → API Keys | Scope to the minimum permission the service actually needs (mail send only) when generating the replacement |
| `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET` | Google Cloud Console / GitHub OAuth App settings respectively | Rotating invalidates any in-flight OAuth authorization code exchanges — low blast radius, but coordinate if traffic is live |
| `ESCROW_WEBHOOK_SECRET` | Regenerate and update both this service's env and whatever sends the webhook | Both sides must be updated together — an old value on one side and new on the other fails signature verification |
| `PUSH_PROVIDER_KEY` | Push provider's dashboard (VAPID keys — see `apps/backend/notifications/push/`) | Rotating VAPID keys invalidates existing push subscriptions; clients must re-subscribe |
| `STORAGE_PRIMARY_KEY_ID` / `STORAGE_PRIMARY_SECRET` (Cloudflare R2 / AWS S3) | Automated — certmanager storage key rotation (#400): `POST /api/v1/storage/rotation`, or the hourly scheduler | Rotates every 90 days with zero downtime via dual-credential fallback (new key verified and promoted before the old one is revoked after a 24h grace period). See `apps/backend/certmanager/README.md` |

## What's not yet implemented

- **Automated rotation** (a script or scheduled job that rotates a credential without manual dashboard steps) is out of scope for #81 — this repo has no secrets-manager integration (Vault, AWS Secrets Manager) live yet to automate against. The table above is the manual procedure until one exists.
- **Alerting on detection** beyond the CI check failing the PR/push (e.g. a Slack/PagerDuty notification) is not wired up — no alerting integration exists elsewhere in this repo's CI to hook into.
