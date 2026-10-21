import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DlqTriageWorker } from "../dlqTriageWorker.js";
import type { DlqTriageJobData } from "@delegolabs/types";

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  zadd: vi.fn(),
  zrangebyscore: vi.fn(),
  zrem: vi.fn(),
};

describe("DlqTriageWorker", () => {
  let worker: DlqTriageWorker;
  const mockAlerter = {
    sendAlert: vi.fn().mockResolvedValue({ sent: true, statusCode: 200 }),
    formatQuarantineAlert: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new DlqTriageWorker(mockRedis as any, {
      alerter: mockAlerter as any,
      policy: {
        transientErrorPatterns: ["timeout", "econnrefused", "rate limit"],
        maxAutomaticRetries: 3,
        slackWebhookUrl: "https://hooks.slack.com/services/test",
      },
      config: {
        baseDelayMs: 1000,
        multiplier: 2,
      },
    });
  });

  afterEach(() => {
    worker.stop();
  });

  it("should triage transient error with retry_now on first attempt", async () => {
    const retrySpy = vi.fn().mockResolvedValue(undefined);
    worker.setRetryHandler(retrySpy);

    const job: DlqTriageJobData = {
      jobId: "job-1",
      errorMessage: "Connection timeout to Horizon",
      failedAt: Date.now(),
      retryCount: 0,
      payload: { tx: "xdr" },
    };

    const result = await worker.triageJob(job);
    expect(result.decision).toBe("retry_now");
    expect(retrySpy).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", retryCount: 1 }));
  });

  it("should schedule retry with backoff for retryCount > 0", async () => {
    const job: DlqTriageJobData = {
      jobId: "job-2",
      errorMessage: "econnrefused: Horizon down",
      failedAt: Date.now(),
      retryCount: 1,
      payload: { tx: "xdr" },
    };

    const result = await worker.triageJob(job);
    expect(result.decision).toBe("schedule_retry");
    expect(result.nextRetryDelayMs).toBe(2000); // 1000 * 2^1 = 2000ms
    expect(mockRedis.zadd).toHaveBeenCalledWith(
      "tx:dlq:scheduled_retries",
      expect.any(Number),
      expect.stringContaining("job-2")
    );
  });

  it("should quarantine and send Slack alert when transient retries exceeded", async () => {
    const job: DlqTriageJobData = {
      jobId: "job-3",
      errorMessage: "rate limit exceeded",
      failedAt: Date.now(),
      retryCount: 3, // equals maxAutomaticRetries (3)
      payload: {},
    };

    const result = await worker.triageJob(job);
    expect(result.decision).toBe("quarantine");
    expect(mockRedis.set).toHaveBeenCalledWith(
      "tx:dlq:quarantine:job-3",
      expect.stringContaining("quarantinedAt")
    );
    expect(mockAlerter.sendAlert).toHaveBeenCalledWith(job, expect.any(String));
    expect(result.alertSent).toBe(true);
  });

  it("should quarantine permanent errors immediately and alert", async () => {
    const job: DlqTriageJobData = {
      jobId: "job-permanent",
      errorMessage: "Invalid XDR: failed to parse signature",
      failedAt: Date.now(),
      retryCount: 0,
      payload: {},
    };

    const result = await worker.triageJob(job);
    expect(result.decision).toBe("quarantine");
    expect(mockRedis.set).toHaveBeenCalledWith(
      "tx:dlq:quarantine:job-permanent",
      expect.stringContaining("quarantinedAt")
    );
    expect(mockAlerter.sendAlert).toHaveBeenCalledWith(job, expect.any(String));
  });

  it("should process due scheduled retries from Redis sorted set", async () => {
    const retrySpy = vi.fn().mockResolvedValue(undefined);
    worker.setRetryHandler(retrySpy);

    const scheduledJob: DlqTriageJobData = {
      jobId: "job-sched-1",
      errorMessage: "timeout",
      failedAt: Date.now(),
      retryCount: 2,
      payload: {},
    };

    const itemStr = `job-sched-1:::${JSON.stringify(scheduledJob)}`;
    mockRedis.zrangebyscore.mockResolvedValue([itemStr]);

    const count = await worker.processDueScheduledRetries();
    expect(count).toBe(1);
    expect(retrySpy).toHaveBeenCalledWith(scheduledJob);
    expect(mockRedis.zrem).toHaveBeenCalledWith("tx:dlq:scheduled_retries", itemStr);
  });

  it("should allow dynamic policy updates", () => {
    worker.updatePolicy({ maxAutomaticRetries: 5 });
    expect(worker.getPolicy().maxAutomaticRetries).toBe(5);
  });
});
