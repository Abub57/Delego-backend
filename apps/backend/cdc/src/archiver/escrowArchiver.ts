/**
 * Escrow snapshot archiver (Issue #290).
 *
 * One run = one nightly job:
 *
 *   1. Count how many rows in the live escrow table settled longer ago than the
 *      retention window (default 90 days).
 *   2. Move them into `escrow_archives` in bounded batches, oldest first, each
 *      batch a single transaction that archives the full row snapshot and prunes
 *      it from the live table.
 *   3. Stop at `maxBatches`, so a large backlog drains over several nights
 *      instead of holding a long transaction on the primary database.
 *
 * The run is idempotent and multi-instance safe: `runExclusive` (see
 * {@link EscrowArchiveStore}) admits a single runner, `FOR UPDATE SKIP LOCKED`
 * keeps two runners off the same rows, and `ON CONFLICT (escrow_id) DO NOTHING`
 * means a re-run can never duplicate an archive record or drop an unarchived row.
 */

import { createLogger, type Logger } from "@delegolabs/utils";
import type { Pool } from "pg";

import { PostgresEscrowArchiveStore, type EscrowArchiveStore } from "./store.js";
import {
  DEFAULT_ESCROW_ARCHIVER_CONFIG,
  EscrowArchiverConfigError,
  type ArchiveRunResult,
  type EscrowArchiverConfig,
  type SettledEscrow,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Moves long-settled escrows out of the live table into cold storage. */
export class EscrowArchiver {
  readonly config: EscrowArchiverConfig;
  private readonly log: Logger;

  constructor(
    private readonly store: EscrowArchiveStore,
    config: Partial<EscrowArchiverConfig> = {},
    logger?: Logger
  ) {
    this.config = {
      ...DEFAULT_ESCROW_ARCHIVER_CONFIG,
      ...config,
      sourceColumns: {
        ...DEFAULT_ESCROW_ARCHIVER_CONFIG.sourceColumns,
        ...config.sourceColumns,
      },
    };
    assertPositiveInt(this.config.retentionDays, "retentionDays");
    assertPositiveInt(this.config.batchSize, "batchSize");
    assertPositiveInt(this.config.maxBatches, "maxBatches");
    this.log = logger ?? createLogger("cdc:archiver", process.env.LOG_LEVEL ?? "info");
  }

  /**
   * Runs one archive/prune pass.
   *
   * @param now Clock to measure the retention window against; injectable so the
   *            window is testable without time travel.
   */
  async runOnce(now: Date = new Date()): Promise<ArchiveRunResult> {
    const startedAt = now.toISOString();
    const started = Date.now();
    const cutoff = new Date(now.getTime() - this.config.retentionDays * DAY_MS);

    let pending = 0;
    let archived = 0;
    let batches = 0;
    let skipped = false;
    const errors: string[] = [];

    const run = async (): Promise<void> => {
      pending = await this.store.countSettledBefore(cutoff);
      if (pending === 0) {
        this.log.info("No escrows past the retention window", {
          retentionDays: this.config.retentionDays,
          cutoff: cutoff.toISOString(),
        });
        return;
      }

      this.log.info("Archiving settled escrows", {
        pending,
        retentionDays: this.config.retentionDays,
        cutoff: cutoff.toISOString(),
        batchSize: this.config.batchSize,
        maxBatches: this.config.maxBatches,
      });

      while (batches < this.config.maxBatches) {
        let moved: SettledEscrow[];
        try {
          moved = await this.store.moveSettledBatch(cutoff, this.config.batchSize);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(message);
          this.log.error("Escrow archive batch failed", { error: message, batches });
          break;
        }

        if (moved.length === 0) break;

        archived += moved.length;
        batches += 1;
        this.log.debug("Escrow archive batch moved", {
          batch: batches,
          moved: moved.length,
          oldestSettledAt: moved[0]?.settledAt,
        });
      }

      if (batches === this.config.maxBatches && pending > archived) {
        this.log.warn("Archive run hit the batch cap; remaining backlog deferred", {
          pending,
          archived,
          remaining: pending - archived,
          maxBatches: this.config.maxBatches,
        });
      }
    };

    try {
      const held = await this.store.runExclusive(run);
      if (held === null) skipped = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      this.log.error("Escrow archive run failed", { error: message });
    }

    const result: ArchiveRunResult = {
      pending,
      archived,
      batches,
      skipped,
      startedAt,
      durationMs: Date.now() - started,
      errors,
    };

    if (!skipped) {
      const level = errors.length > 0 ? "warn" : "info";
      this.log[level]("Escrow archive run complete", {
        pending: result.pending,
        archived: result.archived,
        batches: result.batches,
        durationMs: result.durationMs,
        errors: result.errors.length,
      });
    }

    return result;
  }
}

/**
 * Reads the archiver's effective configuration from the environment, falling
 * back to {@link DEFAULT_ESCROW_ARCHIVER_CONFIG}.
 */
export function resolveEscrowArchiverConfig(
  env: NodeJS.ProcessEnv = process.env
): EscrowArchiverConfig {
  return {
    retentionDays: readPositiveInt(env, "ESCROW_ARCHIVE_RETENTION_DAYS", 90),
    batchSize: readPositiveInt(env, "ESCROW_ARCHIVE_BATCH_SIZE", 500),
    maxBatches: readPositiveInt(env, "ESCROW_ARCHIVE_MAX_BATCHES", 20),
    sourceTable: env.ESCROW_ARCHIVE_SOURCE_TABLE ?? DEFAULT_ESCROW_ARCHIVER_CONFIG.sourceTable,
    archiveTable: env.ESCROW_ARCHIVE_TABLE ?? DEFAULT_ESCROW_ARCHIVER_CONFIG.archiveTable,
    sourceColumns: {
      id: env.ESCROW_ARCHIVE_ID_COLUMN ?? DEFAULT_ESCROW_ARCHIVER_CONFIG.sourceColumns.id,
      escrowId:
        env.ESCROW_ARCHIVE_ESCROW_ID_COLUMN ??
        DEFAULT_ESCROW_ARCHIVER_CONFIG.sourceColumns.escrowId,
      status:
        env.ESCROW_ARCHIVE_STATUS_COLUMN ?? DEFAULT_ESCROW_ARCHIVER_CONFIG.sourceColumns.status,
      closedAt:
        env.ESCROW_ARCHIVE_CLOSED_AT_COLUMN ?? DEFAULT_ESCROW_ARCHIVER_CONFIG.sourceColumns.closedAt,
    },
  };
}

/** Wires a Postgres-backed archiver against the CDC pool. */
export function createEscrowArchiver(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
  logger?: Logger
): EscrowArchiver {
  const config = resolveEscrowArchiverConfig(env);
  return new EscrowArchiver(new PostgresEscrowArchiveStore(pool, config, logger), config, logger);
}

function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new EscrowArchiverConfigError(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new EscrowArchiverConfigError(`${label} must be a positive integer, got "${value}"`);
  }
}
