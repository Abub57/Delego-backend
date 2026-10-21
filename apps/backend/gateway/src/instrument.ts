/**
 * Sentry bootstrap (Issue #10). Imported first from src/index.ts so the SDK
 * is initialised before any other gateway module is loaded. Keep this file
 * free of other imports.
 */
import { initSentry } from "./observability/sentry.js";

export const sentryConfig = initSentry(process.env);
