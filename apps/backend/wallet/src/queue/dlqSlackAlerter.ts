/**
 * Slack Alerting Client for Quarantined DLQ Jobs
 * Issue #363
 */

import { createLogger, type Logger } from "@delegolabs/utils";
import type { DlqTriageJobData, SlackAlertPayload } from "@delegolabs/types";

export interface SlackAlertResult {
  sent: boolean;
  statusCode?: number;
  error?: string;
}

export class DlqSlackAlerter {
  private log: Logger;

  constructor(
    private readonly webhookUrl?: string,
    logger?: Logger
  ) {
    this.log = logger ?? createLogger("wallet:dlq:slack", process.env.LOG_LEVEL ?? "info");
  }

  /**
   * Formats a detailed Slack message with error snippet, job metadata, and actionable context.
   */
  formatQuarantineAlert(
    job: DlqTriageJobData,
    reason: string
  ): SlackAlertPayload {
    const timeStr = typeof job.failedAt === "number" ? new Date(job.failedAt).toISOString() : String(job.failedAt);
    const errorSnippet = (job.errorStack || job.errorMessage || "Unknown error").slice(0, 500);

    return {
      text: `🚨 [DLQ Alert] Job Quarantined: ${job.jobId} (${job.queueName ?? "default"})`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🚨 Dead Letter Queue (DLQ) Alert: Job Quarantined",
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*Job ID:*\n\`${job.jobId}\``,
            },
            {
              type: "mrkdwn",
              text: `*Queue:*\n${job.queueName ?? "transaction-queue"}`,
            },
            {
              type: "mrkdwn",
              text: `*Failed At:*\n${timeStr}`,
            },
            {
              type: "mrkdwn",
              text: `*Retry Attempts:*\n${job.retryCount}`,
            },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Triage Reason:*\n${reason}`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Error Details / Snippet:*\n\`\`\`${errorSnippet}\`\`\``,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `ℹ️ Manual intervention required. Inspect with \`GET /admin/dlq/entry/${job.jobId}\` or replay via admin portal.`,
            },
          ],
        },
      ],
    };
  }

  /**
   * Sends the Slack alert to the configured webhook URL.
   */
  async sendAlert(
    job: DlqTriageJobData,
    reason: string,
    overrideWebhookUrl?: string
  ): Promise<SlackAlertResult> {
    const url = overrideWebhookUrl || this.webhookUrl || process.env.DLQ_SLACK_WEBHOOK_URL;
    if (!url) {
      this.log.warn("Slack alert skipped: No webhook URL configured", { jobId: job.jobId });
      return { sent: false, error: "No webhook URL configured" };
    }

    const payload = this.formatQuarantineAlert(job, reason);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => "");
        this.log.error("Failed to send Slack alert", {
          status: response.status,
          response: responseText,
          jobId: job.jobId,
        });
        return {
          sent: false,
          statusCode: response.status,
          error: `HTTP ${response.status}: ${responseText}`,
        };
      }

      this.log.info("Slack alert sent successfully for quarantined job", { jobId: job.jobId });
      return { sent: true, statusCode: response.status };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log.error("Slack alert network error", { error: errMsg, jobId: job.jobId });
      return { sent: false, error: errMsg };
    }
  }
}
