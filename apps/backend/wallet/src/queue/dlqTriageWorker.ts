/**
 * Automated DLQ Triage Worker
 * Issue #363
 *
 * Scans the DLQ for failed jobs, categorizes transient vs permanent errors,
 * schedules retries with exponential backoff, and sends formatted Slack alerts
 * for quarantined jobs.
 */

import { Redis } from "ioredis";
import { createLogger, type Logger } from "@delegolabs/utils";
import type {
  DlqTriagePolicy,
  DlqTriageJobData,
  DlqTriageResult,
} from "@delegolabs/types";
import {
  classifyErrorAndDecide,
  DEFAULT_TRANSIENT_PATTERNS,
} from "./dlqClassificationEngine.js";
import { DlqSlackAlerter } from "./dlqSlackAlerter.js";

export interface DlqTriageWorkerConfig {
  policy: DlqTriagePolicy;
  pollIntervalMs?: number;
  baseDelayMs?: number;
  multiplier?: number;
  maxDelayMs?: number;
  dlqKeyPrefix?: string;
  quarantineKeyPrefix?: string;
}

export const DEFAULT_DLQ_TRIAGE_POLICY: DlqTriagePolicy = {
  transientErrorPatterns: [...DEFAULT_TRANSIENT_PATTERNS],
  maxAutomaticRetries: 3,
  slackWebhookUrl: process.env.DLQ_SLACK_WEBHOOK_URL ?? "",
};

export class DlqTriageWorker {
  private redis: Redis;
  private config: DlqTriageWorkerConfig;
  private alerter: DlqSlackAlerter;
  private log: Logger;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private retryHandler?: (job: DlqTriageJobData) => Promise<void>;

  constructor(
    redis: Redis,
    options?: {
      policy?: Partial<DlqTriagePolicy>;
      config?: Partial<Omit<DlqTriageWorkerConfig, "policy">>;
      alerter?: DlqSlackAlerter;
      logger?: Logger;
      retryHandler?: (job: DlqTriageJobData) => Promise<void>;
    }
  ) {
    this.redis = redis;
    this.config = {
      policy: {
        ...DEFAULT_DLQ_TRIAGE_POLICY,
        ...options?.policy,
      },
      pollIntervalMs: options?.config?.pollIntervalMs ?? 15000,
      baseDelayMs: options?.config?.baseDelayMs ?? 2000,
      multiplier: options?.config?.multiplier ?? 2,
      maxDelayMs: options?.config?.maxDelayMs ?? 120000,
      dlqKeyPrefix: options?.config?.dlqKeyPrefix ?? "tx:dlq:",
      quarantineKeyPrefix: options?.config?.quarantineKeyPrefix ?? "tx:dlq:quarantine:",
    };

    this.log = options?.logger ?? createLogger("wallet:dlq:triage", process.env.LOG_LEVEL ?? "info");
    this.alerter = options?.alerter ?? new DlqSlackAlerter(this.config.policy.slackWebhookUrl, this.log);
    this.retryHandler = options?.retryHandler;
  }

  getPolicy(): DlqTriagePolicy {
    return { ...this.config.policy };
  }

  updatePolicy(updates: Partial<DlqTriagePolicy>): DlqTriagePolicy {
    this.config.policy = {
      ...this.config.policy,
      ...updates,
    };
    return this.getPolicy();
  }

  setRetryHandler(handler: (job: DlqTriageJobData) => Promise<void>): void {
    this.retryHandler = handler;
  }

  /**
   * Triages a single DLQ job candidate.
   */
  async triageJob(job: DlqTriageJobData): Promise<DlqTriageResult> {
    const classification = classifyErrorAndDecide(job, this.config.policy, {
      baseDelayMs: this.config.baseDelayMs,
      multiplier: this.config.multiplier,
      maxDelayMs: this.config.maxDelayMs,
    });

    const result: DlqTriageResult = {
      jobId: job.jobId,
      decision: classification.decision,
      reason: classification.reason,
      retryCount: job.retryCount,
    };

    switch (classification.decision) {
      case "retry_now": {
        this.log.info("Triaged job for immediate retry", { jobId: job.jobId, reason: classification.reason });
        if (this.retryHandler) {
          try {
            await this.retryHandler({ ...job, retryCount: job.retryCount + 1 });
          } catch (retryErr) {
            this.log.error("Failed to execute immediate retry", {
              jobId: job.jobId,
              error: retryErr instanceof Error ? retryErr.message : String(retryErr),
            });
          }
        }
        break;
      }

      case "schedule_retry": {
        const delayMs = classification.retryDelayMs ?? this.config.baseDelayMs ?? 2000;
        const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
        result.nextRetryDelayMs = delayMs;
        result.nextRetryAt = nextRetryAt;

        this.log.info("Triaged job for scheduled retry with exponential backoff", {
          jobId: job.jobId,
          delayMs,
          nextRetryAt,
          attempt: job.retryCount + 1,
        });

        // Store scheduled retry in Redis sorted set
        try {
          const scheduledKey = "tx:dlq:scheduled_retries";
          const scheduledData = JSON.stringify({
            ...job,
            retryCount: job.retryCount + 1,
            nextRetryAt,
          });
          await this.redis.zadd(scheduledKey, Date.now() + delayMs, `${job.jobId}:::${scheduledData}`);
        } catch (schedErr) {
          this.log.error("Failed to store scheduled retry in Redis", {
            jobId: job.jobId,
            error: schedErr instanceof Error ? schedErr.message : String(schedErr),
          });
        }
        break;
      }

      case "quarantine": {
        const quarantinedAt = new Date().toISOString();
        result.quarantinedAt = quarantinedAt;

        this.log.warn("Triaged job quarantined", {
          jobId: job.jobId,
          reason: classification.reason,
          category: classification.category,
        });

        // Store quarantined job in Redis
        try {
          const quarantineKey = `${this.config.quarantineKeyPrefix}${job.jobId}`;
          await this.redis.set(
            quarantineKey,
            JSON.stringify({
              ...job,
              quarantinedAt,
              reason: classification.reason,
            })
          );
        } catch (qErr) {
          this.log.error("Failed to store quarantined job in Redis", {
            jobId: job.jobId,
            error: qErr instanceof Error ? qErr.message : String(qErr),
          });
        }

        // Send Slack alert
        const alertRes = await this.alerter.sendAlert(job, classification.reason);
        result.alertSent = alertRes.sent;
        break;
      }

      case "discard": {
        this.log.info("Triaged job discarded", { jobId: job.jobId, reason: classification.reason });
        break;
      }
    }

    return result;
  }

  /**
   * Process due scheduled retries.
   */
  async processDueScheduledRetries(): Promise<number> {
    const scheduledKey = "tx:dlq:scheduled_retries";
    const now = Date.now();

    try {
      const items = await this.redis.zrangebyscore(scheduledKey, 0, now);
      if (items.length === 0) return 0;

      let retriedCount = 0;
      for (const item of items) {
        const [, jsonStr] = item.split(":::");
        if (!jsonStr) {
          await this.redis.zrem(scheduledKey, item);
          continue;
        }

        try {
          const jobData = JSON.parse(jsonStr) as DlqTriageJobData;
          if (this.retryHandler) {
            await this.retryHandler(jobData);
          }
          await this.redis.zrem(scheduledKey, item);
          retriedCount++;
        } catch (err) {
          this.log.error("Error processing due scheduled retry", {
            item,
            error: err instanceof Error ? err.message : String(err),
          });
          // Remove from scheduled list to prevent infinite loop
          await this.redis.zrem(scheduledKey, item);
        }
      }

      return retriedCount;
    } catch (err) {
      this.log.error("Failed to query scheduled retries", {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  /**
   * Start background triage worker loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.log.info("DLQ Triage worker started", { pollIntervalMs: this.config.pollIntervalMs });

    this.timer = setInterval(async () => {
      try {
        await this.processDueScheduledRetries();
      } catch (err) {
        this.log.error("Error in DLQ triage poll cycle", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.config.pollIntervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stop background triage worker.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.log.info("DLQ Triage worker stopped");
  }
}
