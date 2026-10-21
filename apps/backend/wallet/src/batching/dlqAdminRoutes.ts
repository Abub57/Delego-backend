/**
 * Transaction Dead Letter Queue Admin API Routes
 * Issue #143
 *
 * GET  /admin/dlq/metrics              – DLQ metrics
 * GET  /admin/dlq/entries              – list DLQ entries
 * GET  /admin/dlq/entry/:id            – get DLQ entry
 * POST /admin/dlq/replay/:id           – manual replay
 * POST /admin/dlq/archive/:id          – archive entry
 * POST /admin/dlq/discard/:id          – discard entry
 * POST /admin/dlq/auto-replay          – trigger auto-replay
 * POST /admin/dlq/cleanup              – enforce retention
 * GET  /admin/dlq/alerts               – get alerts
 * GET  /admin/dlq/retry-policies       – get retry policies
 * POST /admin/dlq/retry-policies       – update retry policies
 */
import type { IncomingMessage } from "node:http";
import { route, json, type Route } from "@delegolabs/utils";
import {
  getDLQMetrics,
  getDLQEntry,
  manualReplay,
  archiveEntry,
  discardEntry,
  processAutoReplays,
  enforceRetentionPolicy,
  getAlerts,
  getRetryPolicies,
  setRetryPolicies,
  addToDLQ,
  type RetryPolicy,
} from "../queue/transactionDLQ.js";
import { addTransactionToQueue } from "../queue/txQueue.js";
import { createLogger } from "@delegolabs/utils";
import type { TransactionRequest, DlqTriagePolicy } from "@delegolabs/types";

const log = createLogger("wallet:admin:dlq", process.env.LOG_LEVEL ?? "info");

async function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as T) : ({} as T));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function registerDLQAdminRoutes(): Route[] {
  return [
    // Get DLQ metrics
    route("GET", "/admin/dlq/metrics", async (_req, res) => {
      try {
        const metrics = await getDLQMetrics();
        json(res, 200, { data: metrics, error: null });
      } catch (err: any) {
        log.error("GET DLQ metrics error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // List DLQ entries (basic listing via Redis sorted set)
    route("GET", "/admin/dlq/entries", async (req, res) => {
      try {
        const url = new URL(
          req.url ?? "",
          `http://${req.headers.host ?? "localhost"}`
        );
        const status = url.searchParams.get("status");
        const category = url.searchParams.get("category");
        const limit = parseInt(url.searchParams.get("limit") ?? "50");

        // Return metrics summary since individual listing would require
        // fetching all entries
        const metrics = await getDLQMetrics();
        json(res, 200, {
          data: {
            totalEntries: metrics.totalEntries,
            byStatus: metrics.byStatus,
            byCategory: metrics.byCategory,
            filters: { status, category, limit },
            note: "Use GET /admin/dlq/entry/:id for individual entries",
          },
          error: null,
        });
      } catch (err: any) {
        log.error("GET DLQ entries error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Get specific DLQ entry
    route("GET", "/admin/dlq/entry/:id", async (_req, res, params) => {
      try {
        const entry = await getDLQEntry(params.id);
        if (!entry) {
          json(res, 404, {
            data: null,
            error: { code: "NOT_FOUND", message: `DLQ entry not found: ${params.id}` },
          });
          return;
        }
        json(res, 200, { data: entry, error: null });
      } catch (err: any) {
        log.error("GET DLQ entry error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Manual replay
    route("POST", "/admin/dlq/replay/:id", async (_req, res, params) => {
      try {
        const replayFn = async (request: TransactionRequest) => {
          const result = await addTransactionToQueue(request);
          return result.hash;
        };

        const result = await manualReplay(params.id, replayFn);
        if (result.success) {
          json(res, 200, {
            data: { id: params.id, txHash: result.txHash },
            error: null,
          });
        } else {
          json(res, 400, {
            data: null,
            error: { code: "REPLAY_FAILED", message: result.error ?? "Replay failed" },
          });
        }
      } catch (err: any) {
        log.error("POST DLQ replay error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Archive entry
    route("POST", "/admin/dlq/archive/:id", async (_req, res, params) => {
      try {
        const success = await archiveEntry(params.id);
        if (success) {
          json(res, 200, { data: { id: params.id, status: "archived" }, error: null });
        } else {
          json(res, 404, {
            data: null,
            error: { code: "NOT_FOUND", message: `DLQ entry not found: ${params.id}` },
          });
        }
      } catch (err: any) {
        log.error("POST DLQ archive error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Discard entry
    route("POST", "/admin/dlq/discard/:id", async (_req, res, params) => {
      try {
        const success = await discardEntry(params.id);
        if (success) {
          json(res, 200, { data: { id: params.id, status: "discarded" }, error: null });
        } else {
          json(res, 404, {
            data: null,
            error: { code: "NOT_FOUND", message: `DLQ entry not found: ${params.id}` },
          });
        }
      } catch (err: any) {
        log.error("POST DLQ discard error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Trigger auto-replay for transient failures
    route("POST", "/admin/dlq/auto-replay", async (_req, res) => {
      try {
        const replayFn = async (request: TransactionRequest) => {
          const result = await addTransactionToQueue(request);
          return result.hash;
        };

        const result = await processAutoReplays(replayFn);
        json(res, 200, { data: result, error: null });
      } catch (err: any) {
        log.error("POST DLQ auto-replay error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Enforce retention policy
    route("POST", "/admin/dlq/cleanup", async (_req, res) => {
      try {
        const result = await enforceRetentionPolicy();
        json(res, 200, { data: result, error: null });
      } catch (err: any) {
        log.error("POST DLQ cleanup error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Get alerts
    route("GET", "/admin/dlq/alerts", async (req, res) => {
      try {
        const url = new URL(
          req.url ?? "",
          `http://${req.headers.host ?? "localhost"}`
        );
        const limit = parseInt(url.searchParams.get("limit") ?? "50");
        const alerts = await getAlerts(limit);
        json(res, 200, { data: alerts, error: null });
      } catch (err: any) {
        log.error("GET DLQ alerts error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Get retry policies
    route("GET", "/admin/dlq/retry-policies", async (_req, res) => {
      try {
        const policies = getRetryPolicies();
        json(res, 200, { data: policies, error: null });
      } catch (err: any) {
        log.error("GET DLQ retry policies error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Update retry policies
    route("POST", "/admin/dlq/retry-policies", async (req, res) => {
      try {
        const body = await readBody<{ policies: RetryPolicy[] }>(req);

        if (!body.policies || !Array.isArray(body.policies)) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "policies array is required",
            },
          });
          return;
        }

        setRetryPolicies(body.policies);
        json(res, 200, { data: { updated: body.policies.length }, error: null });
      } catch (err: any) {
        log.error("POST DLQ retry policies error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Manually add to DLQ (for testing or manual intervention)
    route("POST", "/admin/dlq/add", async (req, res) => {
      try {
        const body = await readBody<{
          id?: string;
          request: TransactionRequest;
          failure: {
            code: string;
            message: string;
            retryable?: boolean;
            txHash?: string;
          };
          attempts?: number;
        }>(req);

        if (!body.request || !body.failure) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "request and failure are required",
            },
          });
          return;
        }

        const id = body.id ?? `dlq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const entry = await addToDLQ(
          id,
          "manual",
          body.request,
          {
            code: body.failure.code,
            message: body.failure.message,
            retryable: body.failure.retryable ?? false,
            txHash: body.failure.txHash,
          },
          body.attempts ?? 0
        );

        json(res, 201, { data: entry, error: null });
      } catch (err: any) {
        log.error("POST DLQ add error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Issue #363: Trigger DLQ triage on a job or entry
    route("POST", "/admin/dlq/triage", async (req, res) => {
      try {
        const body = await readBody<{
          jobId: string;
          errorMessage: string;
          errorCode?: string;
          errorStack?: string;
          failedAt?: string | number;
          retryCount?: number;
          payload?: unknown;
          policy?: Partial<DlqTriagePolicy>;
        }>(req);

        if (!body.jobId || !body.errorMessage) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "jobId and errorMessage are required",
            },
          });
          return;
        }

        const { classifyErrorAndDecide, DEFAULT_TRANSIENT_PATTERNS } = await import("../queue/dlqClassificationEngine.js");
        const { DlqSlackAlerter } = await import("../queue/dlqSlackAlerter.js");

        const policy: DlqTriagePolicy = {
          transientErrorPatterns: body.policy?.transientErrorPatterns ?? [...DEFAULT_TRANSIENT_PATTERNS],
          maxAutomaticRetries: body.policy?.maxAutomaticRetries ?? 3,
          slackWebhookUrl: body.policy?.slackWebhookUrl ?? process.env.DLQ_SLACK_WEBHOOK_URL ?? "",
        };

        const jobData = {
          jobId: body.jobId,
          errorMessage: body.errorMessage,
          errorCode: body.errorCode,
          errorStack: body.errorStack,
          failedAt: body.failedAt ?? new Date().toISOString(),
          retryCount: body.retryCount ?? 0,
          payload: body.payload ?? {},
        };

        const classification = classifyErrorAndDecide(jobData, policy);
        let alertSent = false;
        if (classification.decision === "quarantine") {
          const alerter = new DlqSlackAlerter(policy.slackWebhookUrl);
          const alertResult = await alerter.sendAlert(jobData, classification.reason);
          alertSent = alertResult.sent;
        }

        json(res, 200, {
          data: {
            jobId: body.jobId,
            decision: classification.decision,
            reason: classification.reason,
            retryCount: jobData.retryCount,
            nextRetryDelayMs: classification.retryDelayMs,
            alertSent,
          },
          error: null,
        });
      } catch (err: any) {
        log.error("POST DLQ triage error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),
  ];
}
