/**
 * Tests for Sentry initialisation (Issue #10).
 *
 * @sentry/node is mocked, so no events or network calls leave the process.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/node";
import { getSentryConfig, initSentry, scrubEvent } from "./sentry.js";

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  isInitialized: vi.fn(() => false),
}));

const DSN = "https://publickey@o0.ingest.sentry.io/0";

describe("initSentry", () => {
  beforeEach(() => {
    vi.mocked(Sentry.init).mockClear();
  });

  it("initialises Sentry with the DSN when SENTRY_DSN is set", () => {
    const config = initSentry({ SENTRY_DSN: DSN, NODE_ENV: "production" });

    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const options = vi.mocked(Sentry.init).mock.calls[0][0]!;
    expect(options.dsn).toBe(DSN);
    expect(options.environment).toBe("production");
    expect(options.tracesSampleRate).toBe(0);
    expect(options.beforeSend).toBe(scrubEvent);
    expect(options.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    });
    expect(config).toEqual({ dsn: DSN, environment: "production", tracesSampleRate: 0 });
  });

  it("does not initialise Sentry when SENTRY_DSN is unset", () => {
    expect(initSentry({ NODE_ENV: "production" })).toBeNull();
    expect(initSentry({ SENTRY_DSN: "   " })).toBeNull();
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("does not initialise Sentry at startup when SENTRY_DSN is unset", async () => {
    vi.resetModules();
    vi.stubEnv("SENTRY_DSN", "");
    try {
      const { sentryConfig } = await import("../instrument.js");
      expect(sentryConfig).toBeNull();
      expect(Sentry.init).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("getSentryConfig", () => {
  it("prefers SENTRY_ENVIRONMENT and falls back to NODE_ENV, then development", () => {
    expect(getSentryConfig({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: "staging", NODE_ENV: "production" })?.environment).toBe("staging");
    expect(getSentryConfig({ SENTRY_DSN: DSN, NODE_ENV: "test" })?.environment).toBe("test");
    expect(getSentryConfig({ SENTRY_DSN: DSN })?.environment).toBe("development");
  });

  it("accepts a traces sample rate in [0, 1] and falls back to 0 otherwise", () => {
    const rate = (value: string) =>
      getSentryConfig({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: value })?.tracesSampleRate;
    expect(rate("0.25")).toBe(0.25);
    expect(rate("1")).toBe(1);
    expect(rate("1.5")).toBe(0);
    expect(rate("-1")).toBe(0);
    expect(rate("abc")).toBe(0);
  });
});

describe("scrubEvent", () => {
  it("removes request data and every user field except the ID", () => {
    const event = scrubEvent({
      type: undefined,
      request: {
        url: "http://localhost/api/v1/orders",
        headers: { authorization: "Bearer secret" },
        cookies: { session: "abc" },
        data: { password: "hunter2" },
        query_string: "token=abc",
      },
      user: { id: "user-1", email: "a@example.com", ip_address: "10.0.0.1" },
    });

    expect(event.request).toEqual({ url: "http://localhost/api/v1/orders" });
    expect(event.user).toEqual({ id: "user-1" });
  });
});
