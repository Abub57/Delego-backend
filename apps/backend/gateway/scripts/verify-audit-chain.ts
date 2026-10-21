#!/usr/bin/env tsx
/**
 * Standalone audit-log hash-chain verification entrypoint (Issue #308).
 *
 * Walks the entire stored `audit_log` hash chain and exits non-zero if any
 * historical row was altered or removed out-of-band. This is the runnable,
 * CI/cron-friendly counterpart to:
 *   - `verifyChain` (packages/utils/src/audit/hashChain.ts), which only
 *     verifies an array of entries the caller already holds in memory; and
 *   - `GET /api/v1/admin/audit-log/verify`, which is admin-authenticated
 *     and only reachable through the gateway HTTP server.
 *
 * The actual walk (whole-chain paging + result formatting) lives in
 * `verifyStoredChain` in `@delegolabs/utils`; this file is only the CLI
 * wrapper (args, connection, exit code).
 *
 * Usage — run from the repository root:
 *   pnpm --filter @delegolabs/utils build
 *   pnpm --filter @delegolabs/gateway exec tsx scripts/verify-audit-chain.ts
 *   pnpm --filter @delegolabs/gateway exec tsx scripts/verify-audit-chain.ts -- --to 2026-01-01T00:00:00Z --json
 *
 * Environment:
 *   DATABASE_URL  Postgres connection string. Defaults to the same local dev
 *                 URL the gateway's audit route uses.
 *
 * Exit codes:
 *   0  chain intact
 *   1  chain broken — tampering detected
 *   2  the check could not run (bad arguments, DB unreachable, …)
 */
import { Client } from "pg";
import { verifyStoredChain, formatChainVerificationReport } from "@delegolabs/utils";

const DEFAULT_DATABASE_URL = "postgresql://delego:delego@localhost:5432/delego";

const USAGE = [
  "Usage: pnpm --filter @delegolabs/gateway exec tsx scripts/verify-audit-chain.ts [options]",
  "",
  "Walks the stored audit_log hash chain and exits non-zero if any row was tampered with.",
  "",
  "Options:",
  "  --to <iso>         Only verify entries with occurred_at <= <iso> (default: whole chain)",
  "  --page-size <n>    Rows fetched per query while walking (default: 10000)",
  "  --json             Print the machine-readable result object instead of a report",
  "  -h, --help         Show this help",
].join("\n");

interface CliOptions {
  to: Date | null;
  pageSize: number | null;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { to: null, pageSize: null, json: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--to") {
      const value = argv[++i];
      if (!value) throw new Error("--to requires an ISO-8601 timestamp");
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`--to is not a valid ISO-8601 timestamp: ${value}`);
      }
      options.to = date;
    } else if (arg === "--page-size") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--page-size must be a positive integer");
      }
      options.pageSize = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });
  await client.connect();

  try {
    const result = await verifyStoredChain(client, {
      to: options.to ?? undefined,
      pageSize: options.pageSize ?? undefined,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatChainVerificationReport(result));
      console.log(
        result.valid
          ? "Audit log chain verification PASSED."
          : "Audit log chain verification FAILED — tampering detected."
      );
    }

    return result.valid ? 0 : 1;
  } finally {
    await client.end();
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`verify-audit-chain: ${message}`);
    process.exit(2);
  });
