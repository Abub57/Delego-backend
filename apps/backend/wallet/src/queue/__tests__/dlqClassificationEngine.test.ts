import { describe, it, expect } from "vitest";
import {
  classifyErrorAndDecide,
  calculateExponentialBackoff,
  DEFAULT_TRANSIENT_PATTERNS,
} from "../dlqClassificationEngine.js";
import type { DlqTriageJobData, DlqTriagePolicy } from "@delegolabs/types";

describe("dlqClassificationEngine", () => {
  const mockPolicy: DlqTriagePolicy = {
    transientErrorPatterns: [...DEFAULT_TRANSIENT_PATTERNS],
    maxAutomaticRetries: 3,
    slackWebhookUrl: "https://hooks.slack.com/services/test",
  };

  describe("calculateExponentialBackoff", () => {
    it("should calculate exponential backoff accurately without jitter", () => {
      expect(calculateExponentialBackoff(0, { baseDelayMs: 2000, multiplier: 2 })).toBe(2000);
      expect(calculateExponentialBackoff(1, { baseDelayMs: 2000, multiplier: 2 })).toBe(4000);
      expect(calculateExponentialBackoff(2, { baseDelayMs: 2000, multiplier: 2 })).toBe(8000);
      expect(calculateExponentialBackoff(3, { baseDelayMs: 2000, multiplier: 2 })).toBe(16000);
    });

    it("should cap at maxDelayMs", () => {
      const delay = calculateExponentialBackoff(10, { baseDelayMs: 2000, multiplier: 2, maxDelayMs: 30000 });
      expect(delay).toBe(30000);
    });
  });

  describe("classifyErrorAndDecide", () => {
    it("should classify transient network timeouts and decide retry", () => {
      const job: DlqTriageJobData = {
        jobId: "job-timeout",
        errorMessage: "ETIMEDOUT: Connection timed out to Horizon server",
        errorCode: "ETIMEDOUT",
        failedAt: Date.now(),
        retryCount: 0,
        payload: { tx: "xdr" },
      };

      const result = classifyErrorAndDecide(job, mockPolicy);
      expect(result.category).toBe("transient");
      expect(result.decision).toBe("retry_now");
      expect(result.matchedPattern).toBe("etimedout");
    });

    it("should schedule retry with backoff for retryCount > 0 on transient error", () => {
      const job: DlqTriageJobData = {
        jobId: "job-transient-retry",
        errorMessage: "fetch failed with HTTP 503 Service Unavailable",
        failedAt: Date.now(),
        retryCount: 1,
        payload: { tx: "xdr" },
      };

      const result = classifyErrorAndDecide(job, mockPolicy, { baseDelayMs: 2000, multiplier: 2 });
      expect(result.category).toBe("transient");
      expect(result.decision).toBe("schedule_retry");
      expect(result.retryDelayMs).toBe(4000);
    });

    it("should quarantine transient errors exceeding maxAutomaticRetries", () => {
      const job: DlqTriageJobData = {
        jobId: "job-transient-exceeded",
        errorMessage: "Rate limit exceeded (HTTP 429)",
        failedAt: Date.now(),
        retryCount: 3, // equals maxAutomaticRetries (3)
        payload: {},
      };

      const result = classifyErrorAndDecide(job, mockPolicy);
      expect(result.category).toBe("transient");
      expect(result.decision).toBe("quarantine");
      expect(result.reason).toContain("exceeded max automatic retries");
    });

    it("should classify permanent malformed XDR errors and quarantine immediately", () => {
      const job: DlqTriageJobData = {
        jobId: "job-permanent-xdr",
        errorMessage: "Invalid XDR: failed to parse transaction payload",
        failedAt: Date.now(),
        retryCount: 0,
        payload: {},
      };

      const result = classifyErrorAndDecide(job, mockPolicy);
      expect(result.category).toBe("permanent");
      expect(result.decision).toBe("quarantine");
      expect(result.matchedPattern).toBe("invalid xdr");
    });

    it("should classify authentication failures as permanent and quarantine", () => {
      const job: DlqTriageJobData = {
        jobId: "job-auth-fail",
        errorMessage: "Unauthorized access denied to account credentials",
        failedAt: Date.now(),
        retryCount: 0,
        payload: {},
      };

      const result = classifyErrorAndDecide(job, mockPolicy);
      expect(result.category).toBe("permanent");
      expect(result.decision).toBe("quarantine");
    });

    it("should classify simulation failures as permanent and quarantine", () => {
      const job: DlqTriageJobData = {
        jobId: "job-sim-fail",
        errorMessage: "Contract simulation failed: HostError Error(Contract, #101)",
        failedAt: Date.now(),
        retryCount: 0,
        payload: {},
      };

      const result = classifyErrorAndDecide(job, mockPolicy);
      expect(result.category).toBe("permanent");
      expect(result.decision).toBe("quarantine");
    });

    it("should quarantine unclassified errors as permanent", () => {
      const job: DlqTriageJobData = {
        jobId: "job-unknown",
        errorMessage: "Mysterious catastrophic database inconsistency",
        failedAt: Date.now(),
        retryCount: 0,
        payload: {},
      };

      const result = classifyErrorAndDecide(job, mockPolicy);
      expect(result.category).toBe("permanent");
      expect(result.decision).toBe("quarantine");
    });
  });
});
