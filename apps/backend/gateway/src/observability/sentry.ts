/**
 * Sentry error tracking for the gateway (Issue #10).
 *
 * Enabled only when SENTRY_DSN is set; otherwise the SDK is never initialised
 * and nothing is sent. This module only depends on @sentry/node so that it can
 * be loaded (via src/instrument.ts) before the rest of the gateway.
 */
import * as Sentry from "@sentry/node";

export interface SentryConfig {
  dsn: string;
  environment: string;
  tracesSampleRate: number;
}

/** Reads the Sentry configuration, or returns null when SENTRY_DSN is unset. */
export function getSentryConfig(env: NodeJS.ProcessEnv = process.env): SentryConfig | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;

  const rate = Number(env.SENTRY_TRACES_SAMPLE_RATE);
  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || "development",
    // Unset, invalid or out-of-range values fall back to 0 (tracing off).
    tracesSampleRate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0,
  };
}

/**
 * Initialises Sentry when SENTRY_DSN is set and returns the resolved config,
 * or null (without touching the SDK) when it is not.
 */
export function initSentry(env: NodeJS.ProcessEnv = process.env): SentryConfig | null {
  const config = getSentryConfig(env);
  if (!config) return null;

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    tracesSampleRate: config.tracesSampleRate,
    // Send nothing beyond the explicit request/user IDs attached per event.
    // (`dataCollection` replaces the pre-v11 `sendDefaultPii` option.)
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    },
    beforeSend: scrubEvent,
  });
  return config;
}

/** Strips request data and all user fields except the ID from outgoing events. */
export function scrubEvent<E extends Sentry.ErrorEvent>(event: E): E {
  if (event.request) {
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
  }
  if (event.user) {
    event.user = event.user.id !== undefined ? { id: event.user.id } : {};
  }
  return event;
}
