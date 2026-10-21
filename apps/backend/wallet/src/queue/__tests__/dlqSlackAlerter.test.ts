import { describe, it, expect, vi, beforeEach } from "vitest";
import { DlqSlackAlerter } from "../dlqSlackAlerter.js";
import type { DlqTriageJobData } from "@delegolabs/types";

describe("DlqSlackAlerter", () => {
  const mockJob: DlqTriageJobData = {
    jobId: "job-alert-123",
    queueName: "tx-submission-queue",
    errorMessage: "Simulation failed with code 101",
    errorStack: "Error: Simulation failed\n  at simulateTx (simulator.ts:42)",
    failedAt: "2026-09-28T14:00:00.000Z",
    retryCount: 3,
    payload: { source: "GA123" },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should format Slack blocks correctly with error snippets and metadata", () => {
    const alerter = new DlqSlackAlerter("https://hooks.slack.com/services/test");
    const payload = alerter.formatQuarantineAlert(mockJob, "Permanent error detected");

    expect(payload.text).toContain("job-alert-123");
    expect(payload.blocks).toBeDefined();
    expect(payload.blocks?.length).toBeGreaterThan(3);

    const errorBlock = payload.blocks?.find((b: any) => b.text?.text?.includes("Error Details / Snippet"));
    expect(errorBlock).toBeDefined();
  });

  it("should return false if no webhook URL is configured", async () => {
    const alerter = new DlqSlackAlerter("");
    const result = await alerter.sendAlert(mockJob, "Permanent error");
    expect(result.sent).toBe(false);
    expect(result.error).toBe("No webhook URL configured");
  });

  it("should post payload to webhook URL and return sent: true on HTTP 200", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok",
    } as Response);

    const alerter = new DlqSlackAlerter("https://hooks.slack.com/services/test");
    const result = await alerter.sendAlert(mockJob, "Permanent error");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/test",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(result.sent).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it("should handle HTTP errors gracefully", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    } as Response);

    const alerter = new DlqSlackAlerter("https://hooks.slack.com/services/test");
    const result = await alerter.sendAlert(mockJob, "Permanent error");

    expect(result.sent).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.error).toContain("HTTP 500");
  });

  it("should handle network exceptions gracefully", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("Network connection dropped"));

    const alerter = new DlqSlackAlerter("https://hooks.slack.com/services/test");
    const result = await alerter.sendAlert(mockJob, "Permanent error");

    expect(result.sent).toBe(false);
    expect(result.error).toBe("Network connection dropped");
  });
});
