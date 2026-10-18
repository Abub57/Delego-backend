import { sequelize } from "../db.js";
import { matcherService } from "../services/matcherService.js";
import { resolverService } from "../services/resolverService.js";
import { reconciliationJobService } from "../services/reconciliationJobService.js";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("reconciliation:daily", process.env.LOG_LEVEL ?? "info");

/**
 * Daily Reconciliation Job
 * Runs daily to reconcile internal records with external statements
 */
export async function runDailyReconciliation(): Promise<void> {
  log.info("Starting daily reconciliation");

  // Get configuration
  const accounts = process.env.RECONCILIATION_ACCOUNTS?.split(",") || ["all"];
  // Window boundaries are computed from UTC calendar fields (Issue #339):
  // `date.getDate()` / `setDate()` operate in the server's local timezone,
  // which on a non-UTC host shifts the "daily" window away from the UTC day
  // boundary used everywhere records are actually timestamped — splitting
  // orders near midnight across the wrong settlement/reconciliation day.
  const date = new Date();
  const startDate = new Date(date);
  startDate.setUTCDate(date.getUTCDate() - 1);
  const endDate = date;

  // Create job
  const job = await reconciliationJobService.createJob({
    type: "daily",
    startDate: startDate.toISOString().split("T")[0],
    endDate: endDate.toISOString().split("T")[0],
    accounts,
  });

  log.info("Created reconciliation job", { jobId: job.id });

  // Update status to running
  await reconciliationJobService.updateJobStatus(job.id, "running");

  try {
    // Fetch records from internal system
    const internalRecords = await fetchInternalRecords(startDate, endDate, accounts);

    // Fetch records from external system
    const externalRecords = await fetchExternalRecords(startDate, endDate, accounts);

    // Match records
    const matchResults = await matcherService.matchRecords(job.id, internalRecords, externalRecords);

    // Auto-resolve discrepancies
    const autoResolveResults = await resolverService.autoResolveDiscrepancies(job.id);

    // Complete job
    await reconciliationJobService.completeJob(
      job.id,
      internalRecords.length,
      matchResults.matched,
      matchResults.discrepancies,
    );

    log.info("Daily reconciliation completed", {
      jobId: job.id,
      total: internalRecords.length,
      matched: matchResults.matched,
      discrepancies: matchResults.discrepancies,
      autoResolved: autoResolveResults.resolved,
    });
  } catch (err) {
    log.error("Daily reconciliation failed", { error: err instanceof Error ? err.message : String(err) });
    await reconciliationJobService.cancelJob(job.id);
    throw err;
  } finally {
    await sequelize.close();
  }
}

/**
 * Fetch internal records
 */
async function fetchInternalRecords(_startDate: Date, _endDate: Date, _accounts: string[]): Promise<Array<{
  id: string;
  amount: string;
  currency: string;
  date: string;
  reference: string;
  type: string;
  metadata?: Record<string, unknown>;
}>> {
  // In production, this would query the internal payment system
  // For now, return empty array - would be replaced with actual data fetch
  return [];
}

/**
 * Fetch external records
 */
async function fetchExternalRecords(_startDate: Date, _endDate: Date, _accounts: string[]): Promise<Array<{
  id?: string;
  amount: string;
  currency: string;
  date: string;
  reference: string;
  type: string;
  metadata?: Record<string, unknown>;
}>> {
  // In production, this would query the bank/processor API
  // For now, return empty array - would be replaced with actual data fetch
  return [];
}

// Run if executed directly
if (process.argv[1]?.endsWith("dailyReconciliation.ts")) {
  runDailyReconciliation()
    .then(() => {
      log.info("Daily reconciliation finished successfully");
      process.exit(0);
    })
    .catch((err) => {
      log.error("Daily reconciliation failed", { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
}
