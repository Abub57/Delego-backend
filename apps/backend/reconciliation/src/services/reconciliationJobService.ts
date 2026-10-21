import { ReconciliationJob } from "../models/ReconciliationJob.js";
import { ReconciliationRecord } from "../models/ReconciliationRecord.js";
import { ReconciliationReport } from "../models/ReconciliationReport.js";
import { AuditLog } from "../models/AuditLog.js";
import { createLogger, addDecimalStrings } from "@delegolabs/utils";
import { sequelize } from "../db.js";
import { Op } from "sequelize";

const log = createLogger("reconciliation:job", process.env.LOG_LEVEL ?? "info");

/**
 * Reconciliation Job Service - Manages reconciliation job lifecycle
 */
export class ReconciliationJobService {
  /**
   * Create a new reconciliation job
   */
  async createJob(request: {
    type: "daily" | "intraday" | "monthly" | "on_demand";
    startDate: string;
    endDate: string;
    accounts: string[];
    currency?: string;
  }): Promise<ReconciliationJob> {
    const job = await ReconciliationJob.create({
      type: request.type,
      status: "pending",
      startDate: request.startDate,
      endDate: request.endDate,
      accounts: request.accounts,
      totalRecords: 0,
      matchedRecords: 0,
      discrepancies: 0,
      startedAt: new Date(),
    });

    await this.logAudit("job_created", job.id, undefined, {
      type: request.type,
      startDate: request.startDate,
      endDate: request.endDate,
      accounts: request.accounts,
    });

    return job;
  }

  /**
   * Get job by ID
   */
  async getJob(id: string): Promise<ReconciliationJob | null> {
    return ReconciliationJob.findByPk(id);
  }

  /**
   * List jobs
   */
  async listJobs(params?: {
    type?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<ReconciliationJob[]> {
    const where: any = {};
    if (params?.type) where.type = params.type;
    if (params?.status) where.status = params.status;

    return ReconciliationJob.findAll({
      where,
      limit: params?.limit || 50,
      offset: params?.offset || 0,
      order: [["startedAt", "DESC"]],
    });
  }

  /**
   * Update job status
   */
  async updateJobStatus(id: string, status: "pending" | "running" | "completed" | "failed" | "partial"): Promise<ReconciliationJob | null> {
    const job = await ReconciliationJob.findByPk(id);
    if (!job) return null;

    const oldStatus = job.status;
    await job.update({ status });

    await this.logAudit("job_status_changed", job.id, undefined, {
      oldStatus,
      newStatus: status,
    });

    return job;
  }

  /**
   * Complete reconciliation job
   */
  async completeJob(
    id: string,
    totalRecords: number,
    matchedRecords: number,
    discrepancies: number,
  ): Promise<ReconciliationJob | null> {
    const job = await ReconciliationJob.findByPk(id);
    if (!job) return null;

    const status = discrepancies > 0 && discrepancies < totalRecords ? "partial" : "completed";

    await job.update({
      totalRecords,
      matchedRecords,
      discrepancies,
      status,
      completedAt: new Date(),
    });

    // Generate report
    await this.generateReport(job);

    await this.logAudit("job_completed", job.id, undefined, {
      totalRecords,
      matchedRecords,
      discrepancies,
      status,
    });

    return job;
  }

  /**
   * Cancel reconciliation job
   */
  async cancelJob(id: string): Promise<ReconciliationJob | null> {
    const job = await ReconciliationJob.findByPk(id);
    if (!job) return null;

    await job.update({ status: "failed", completedAt: new Date() });

    await this.logAudit("job_cancelled", job.id, undefined, {});

    return job;
  }

  /**
   * Generate reconciliation report
   */
  async generateReport(job: ReconciliationJob): Promise<ReconciliationReport | null> {
    const records = await ReconciliationRecord.findAll({ where: { jobId: job.id } });

    const summary = {
      total: records.length,
      matched: records.filter((r) => r.status === "matched").length,
      discrepancies: records.filter((r) => r.status === "discrepancy").length,
      unresolved: records.filter((r) => r.status === "discrepancy" && !r.resolution).length,
      matchRate: records.length > 0 ? records.filter((r) => r.status === "matched").length / records.length : 0,
    };

    const byType: Record<string, { count: number; amount: string }> = {};
    const byCurrency: Record<string, { count: number; amount: string }> = {};
    const discrepancyCounts: Record<string, { count: number; totalAmount: string }> = {};

    for (const record of records) {
      // By type
      const key = record.internalRecordId.split(":")[0] || "unknown";
      if (!byType[key]) {
        byType[key] = { count: 0, amount: "0" };
      }
      byType[key].count++;
      // Exact BigInt-backed addition — `parseFloat` silently loses precision
      // on stroop amounts exceeding 2^53 - 1 (#338).
      byType[key].amount = addDecimalStrings(byType[key].amount, record.internalAmount);

      // By currency
      if (!byCurrency[record.currency]) {
        byCurrency[record.currency] = { count: 0, amount: "0" };
      }
      byCurrency[record.currency].count++;
      byCurrency[record.currency].amount = addDecimalStrings(byCurrency[record.currency].amount, record.internalAmount);

      // Discrepancies by type
      if (record.discrepancyType) {
        if (!discrepancyCounts[record.discrepancyType]) {
          discrepancyCounts[record.discrepancyType] = { count: 0, totalAmount: "0" };
        }
        discrepancyCounts[record.discrepancyType].count++;
        if (record.discrepancyAmount) {
          discrepancyCounts[record.discrepancyType].totalAmount = addDecimalStrings(
            discrepancyCounts[record.discrepancyType].totalAmount,
            record.discrepancyAmount
          );
        }
      }
    }

    const topDiscrepancies = Object.entries(discrepancyCounts)
      .map(([type, data]) => ({
        type,
        count: data.count,
        totalAmount: data.totalAmount,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const report = await ReconciliationReport.create({
      jobId: job.id,
      reportData: {
        summary,
        byType,
        byCurrency,
        topDiscrepancies,
      },
      generatedAt: new Date(),
    });

    return report;
  }

  /**
   * Log audit event
   */
  private async logAudit(action: string, jobId?: string, recordId?: string, details: Record<string, unknown> = {}): Promise<void> {
    try {
      await AuditLog.create({
        jobId,
        recordId,
        action,
        details,
        timestamp: new Date(),
      });
    } catch (err) {
      log.warn("Failed to log audit event", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Get reconciliation summary
   */
  async getSummary(): Promise<{
    totalJobs: number;
    completedJobs: number;
    pendingJobs: number;
    failedJobs: number;
    totalMatched: number;
    totalDiscrepancies: number;
    averageMatchRate: number;
    lastRun: string;
  }> {
    const jobs = await ReconciliationJob.findAll();

    const completedJobs = jobs.filter((j) => j.status === "completed" || j.status === "partial");
    const pendingJobs = jobs.filter((j) => j.status === "pending");
    const failedJobs = jobs.filter((j) => j.status === "failed");

    const totalMatched = jobs.reduce((sum, j) => sum + j.matchedRecords, 0);
    const totalDiscrepancies = jobs.reduce((sum, j) => sum + j.discrepancies, 0);
    const totalRecords = jobs.reduce((sum, j) => sum + j.totalRecords, 0);

    const lastRun = jobs[0]?.startedAt?.toISOString() || new Date().toISOString();

    return {
      totalJobs: jobs.length,
      completedJobs: completedJobs.length,
      pendingJobs: pendingJobs.length,
      failedJobs: failedJobs.length,
      totalMatched,
      totalDiscrepancies,
      averageMatchRate: totalRecords > 0 ? totalMatched / totalRecords : 0,
      lastRun,
    };
  }

  /**
   * Get unresolved discrepancies
   */
  async getUnresolvedDiscrepancies(): Promise<ReconciliationRecord[]> {
    return ReconciliationRecord.findAll({
      where: {
        status: "discrepancy",
        resolution: { [Op.is]: sequelize.literal("NULL") },
      },
    });
  }
}

export const reconciliationJobService = new ReconciliationJobService();
