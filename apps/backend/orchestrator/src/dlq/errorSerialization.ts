/**
 * Error serialization for DLQ records — Issue #347
 *
 * Jobs moved to the Dead Letter Queue were previously persisted with only
 * `error.message` (via `String(error)` / `error.message` at the call site),
 * discarding the stack trace entirely and any chained `error.cause`. That
 * makes root cause analysis in production effectively guesswork.
 *
 * `serializeError()` captures the full stack string of the top-level error
 * and recursively walks `error.cause` (ES2022 error chaining, and the
 * `cause` property some libs/bullmq wrap errors with) so every DLQ record
 * carries a complete diagnostic trail.
 */

export interface SerializedError {
  /** `error.message`, or `String(error)` for non-Error throwables. */
  message: string;
  /** Full `error.stack`, or empty string when the thrown value has none. */
  stackTrace: string;
  /**
   * One formatted "<name>: <message>\n<stack>" entry per `error.cause` link,
   * ordered from the immediate cause outward. Empty when there is no chain.
   */
  causeChain: string[];
}

const MAX_CAUSE_DEPTH = 10;

export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) {
    return {
      message: String(error),
      stackTrace: "",
      causeChain: [],
    };
  }

  const causeChain: string[] = [];
  let current: unknown = (error as Error & { cause?: unknown }).cause;
  let depth = 0;

  while (current !== undefined && current !== null && depth < MAX_CAUSE_DEPTH) {
    if (current instanceof Error) {
      causeChain.push(
        current.stack ?? `${current.name}: ${current.message}`
      );
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      causeChain.push(String(current));
      current = undefined;
    }
    depth += 1;
  }

  return {
    message: error.message,
    stackTrace: error.stack ?? `${error.name}: ${error.message}`,
    causeChain,
  };
}
