import { AsyncLocalStorage } from "node:async_hooks";
import { maskPii, maskPiiDeep } from "./piiMasking.js";

/** Minimal structured logger — no external dependencies */

export interface LogContext {
  correlationId?: string;
}

const logContextStorage = new AsyncLocalStorage<LogContext>();

export function getLogContext(): LogContext {
  return logContextStorage.getStore() ?? {};
}

export function runWithLogContext<T>(context: LogContext, callback: () => T): T {
  return logContextStorage.run({ ...getLogContext(), ...context }, callback);
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function createLogger(service: string, level = "info"): Logger {
  const levels = ["debug", "info", "warn", "error"];
  const minLevel = levels.indexOf(level);

  function log(
    lvl: string,
    message: string,
    meta?: Record<string, unknown>
  ): void {
    if (levels.indexOf(lvl) < minLevel) return;
    // Scrub PII (emails, phone numbers, credit card / bank identifiers,
    // Stellar secret keys) from the message and metadata before the entry
    // is ever serialized — see #355.
    const entry = {
      timestamp: new Date().toISOString(),
      level: lvl,
      service,
      message: maskPii(message),
      ...maskPiiDeep(meta ?? {}),
      ...getLogContext(),
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(entry));
  }

  return {
    debug: (msg, meta) => log("debug", msg, meta),
    info: (msg, meta) => log("info", msg, meta),
    warn: (msg, meta) => log("warn", msg, meta),
    error: (msg, meta) => log("error", msg, meta),
  };
}
