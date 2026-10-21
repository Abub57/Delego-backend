import { fetchWithCorrelation } from "./correlation.js";

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { json, createLogger } from "@delegolabs/utils";
import { getRequestContext } from "./requestId.js";

export type RASPMode = "monitor" | "block" | "log_only";
export type RASPCategory = "sql_injection" | "xss" | "command_injection" | "path_traversal" | "deserialization" | "custom";
export type RASPSeverity = "low" | "medium" | "high" | "critical";
export type RASPAction = "block" | "alert" | "log";

export interface RASPConfig {
  enabled: boolean;
  mode: RASPMode;
  rules: Array<{
    id: string;
    name: string;
    category: RASPCategory;
    severity: RASPSeverity;
    action: RASPAction;
    pattern: string;
    enabled: boolean;
  }>;
  trustedPaths: string[];
  trustedIPs: string[];
  samplingRate: number;
  siemWebhookUrl?: string;
}

export interface RASPEvent {
  id: string;
  timestamp: string;
  ruleId: string;
  category: string;
  severity: string;
  action: "blocked" | "alerted" | "logged";
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
    clientIP: string;
  };
  matchedPattern: string;
  traceId?: string;
}

export interface RASPMetrics {
  totalEvents: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  byAction: Record<string, number>;
  falsePositiveRate: number;
  avgLatencyMs: number;
  blockedRequests: number;
  sampledRequests: number;
  inspectionErrors: number;
  siemDeliveryFailures: number;
}

const log = createLogger("gateway:rasp", process.env.LOG_LEVEL ?? "info");
const DEFAULT_RULES: RASPConfig["rules"] = [
  { id: "rasp-sqli", name: "SQL injection", category: "sql_injection", severity: "critical", action: "block", pattern: "(?:union\\s+select|(?:or|and)\\s+['\\\"]?1['\\\"]?\\s*=|sleep\\s*\\()", enabled: true },
  { id: "rasp-xss", name: "Cross-site scripting", category: "xss", severity: "high", action: "block", pattern: "(?:<script\\b|javascript:|on(?:error|load|click)\\s*=)", enabled: true },
  { id: "rasp-command", name: "Command injection", category: "command_injection", severity: "critical", action: "block", pattern: "(?:[;&|`]\\s*(?:cat|curl|wget|bash|sh|rm)\\b|\\$\\([^)]*\\))", enabled: true },
  { id: "rasp-traversal", name: "Path traversal", category: "path_traversal", severity: "high", action: "block", pattern: "(?:\\.\\./|%2e%2e%2f|%2fetc%2fpasswd)", enabled: true },
  { id: "rasp-deserialization", name: "Unsafe deserialization", category: "deserialization", severity: "critical", action: "block", pattern: "(?:__proto__|constructor\\[|java\\.lang\\.|\\$type\\s*:)", enabled: true },
];

const metrics: RASPMetrics = { totalEvents: 0, byCategory: {}, bySeverity: {}, byAction: {}, falsePositiveRate: 0, avgLatencyMs: 0, blockedRequests: 0, sampledRequests: 0, inspectionErrors: 0, siemDeliveryFailures: 0 };
let totalDetectionMs = 0;
let evaluationCount = 0;
let falsePositiveCount = 0;
const events: RASPEvent[] = [];

function validMode(value: string | undefined): RASPMode {
  return value === "monitor" || value === "log_only" || value === "block" ? value : "block";
}

function parseRules(value: string | undefined): RASPConfig["rules"] {
  if (!value) return DEFAULT_RULES;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error("rules must be an array");
    return parsed.filter((rule): rule is RASPConfig["rules"][number] => {
      if (!rule || typeof rule !== "object") return false;
      const item = rule as Record<string, unknown>;
      return typeof item.id === "string" && typeof item.pattern === "string" && typeof item.category === "string" && typeof item.severity === "string" && typeof item.action === "string" && typeof item.enabled === "boolean";
    });
  } catch {
    log.warn("Invalid RASP_RULES; using defaults");
    return DEFAULT_RULES;
  }
}

function parseConfig(): RASPConfig {
  const sampling = Number(process.env.RASP_SAMPLING_RATE ?? "1");
  return {
    enabled: process.env.RASP_ENABLED !== "false",
    mode: validMode(process.env.RASP_MODE),
    rules: parseRules(process.env.RASP_RULES),
    trustedPaths: (process.env.RASP_TRUSTED_PATHS ?? "/health,/.well-known").split(",").map((path) => path.trim()).filter(Boolean),
    trustedIPs: (process.env.RASP_TRUSTED_IPS ?? "").split(",").map((ip) => ip.trim()).filter(Boolean),
    samplingRate: Number.isFinite(sampling) ? Math.min(1, Math.max(0, sampling)) : 1,
    siemWebhookUrl: process.env.RASP_SIEM_WEBHOOK_URL || undefined,
  };
}

function headerMap(req: IncomingMessage): Record<string, string> {
  const sensitive = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);
  return Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, sensitive.has(key.toLowerCase()) ? "[REDACTED]" : Array.isArray(value) ? value.join(", ") : value ?? ""]));
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  return (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.socket.remoteAddress) ?? "unknown";
}

function isTrusted(path: string, ip: string, config: RASPConfig): boolean {
  return config.trustedIPs.includes(ip) || config.trustedPaths.some((trusted) => path === trusted || path.startsWith(`${trusted}/`));
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

async function sendToSiem(event: RASPEvent, config: RASPConfig): Promise<void> {
  if (!config.siemWebhookUrl || typeof fetch !== "function") return;
  try {
    const response = await fetchWithCorrelation(config.siemWebhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "delego-gateway-rasp", event }) });
    if (!response.ok) throw new Error(`SIEM responded ${response.status}`);
  } catch (error) {
    metrics.siemDeliveryFailures += 1;
    log.error("RASP SIEM delivery failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

function recordEvent(event: RASPEvent, config: RASPConfig): void {
  events.push(event);
  if (events.length > 1000) events.shift();
  metrics.totalEvents += 1;
  metrics.byCategory[event.category] = (metrics.byCategory[event.category] ?? 0) + 1;
  metrics.bySeverity[event.severity] = (metrics.bySeverity[event.severity] ?? 0) + 1;
  metrics.byAction[event.action] = (metrics.byAction[event.action] ?? 0) + 1;
  if (event.action === "blocked") metrics.blockedRequests += 1;
  log.warn("RASP security event", { id: event.id, ruleId: event.ruleId, category: event.category, severity: event.severity, action: event.action, path: event.request.path, clientIP: event.request.clientIP, traceId: event.traceId });
  void sendToSiem(event, config);
}

function findRule(input: string, config: RASPConfig): RASPConfig["rules"][number] | undefined {
  return config.rules.find((candidate) => {
    if (!candidate.enabled) return false;
    try { return new RegExp(candidate.pattern, "i").test(input); } catch { metrics.inspectionErrors += 1; return false; }
  });
}

export function getRASPConfig(): RASPConfig { return parseConfig(); }
export function getRASPMetrics(): RASPMetrics { return { ...metrics, byCategory: { ...metrics.byCategory }, bySeverity: { ...metrics.bySeverity }, byAction: { ...metrics.byAction } }; }
export function getRASPEvents(): RASPEvent[] { return events.map((event) => ({ ...event, request: { ...event.request, headers: { ...event.request.headers } } })); }
export function markRASPFalsePositive(): void { falsePositiveCount += 1; metrics.falsePositiveRate = metrics.totalEvents === 0 ? 0 : falsePositiveCount / metrics.totalEvents; }
export function resetRASPMetrics(): void {
  Object.assign(metrics, { totalEvents: 0, byCategory: {}, bySeverity: {}, byAction: {}, falsePositiveRate: 0, avgLatencyMs: 0, blockedRequests: 0, sampledRequests: 0, inspectionErrors: 0, siemDeliveryFailures: 0 });
  totalDetectionMs = 0; evaluationCount = 0; falsePositiveCount = 0; events.length = 0;
}

export function createRASPEvent(req: IncomingMessage, rule: RASPConfig["rules"][number], action: RASPEvent["action"], body = "", pattern = rule.pattern): RASPEvent {
  const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
  return { id: randomUUID(), timestamp: new Date().toISOString(), ruleId: rule.id, category: rule.category, severity: rule.severity, action, request: { method: req.method ?? "GET", path, headers: headerMap(req), body: body.slice(0, 1000), clientIP: clientIp(req) }, matchedPattern: pattern, traceId: getRequestContext(req)?.requestId };
}

/** Non-invasive URL/header middleware; request bodies remain available to downstream parsers. */
export function raspMiddleware(config: RASPConfig = parseConfig()) {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): Promise<void> => {
    if (!config.enabled) { next(); return; }
    const started = performance.now();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const ip = clientIp(req);
    if (isTrusted(url.pathname, ip, config) || Math.random() > config.samplingRate) { next(); return; }
    metrics.sampledRequests += 1;
    const input = safeDecode(`${req.method ?? "GET"} ${req.url ?? "/"} ${Object.entries(req.headers).map(([key, value]) => `${key}:${value}`).join(" ")}`);
    const rule = findRule(input, config);
    const elapsed = performance.now() - started;
    totalDetectionMs += elapsed; evaluationCount += 1; metrics.avgLatencyMs = totalDetectionMs / evaluationCount;
    if (!rule) { next(); return; }
    const shouldBlock = config.mode === "block" && rule.action === "block";
    const action: RASPEvent["action"] = shouldBlock ? "blocked" : rule.action === "alert" ? "alerted" : "logged";
    recordEvent(createRASPEvent(req, rule, action), config);
    if (shouldBlock) { json(res, 403, { data: null, error: { code: "RASP_REQUEST_BLOCKED", message: "Request blocked by runtime application protection" } }); return; }
    next();
  };
}

export function simulateRASPAttack(input: { method?: string; path: string; body?: string; ip?: string }, config: RASPConfig = parseConfig()): RASPEvent | null {
  const req = { method: input.method ?? "GET", url: input.path, headers: { host: "simulation" }, socket: { remoteAddress: input.ip ?? "127.0.0.1" } } as unknown as IncomingMessage;
  if (!config.enabled || isTrusted(input.path, input.ip ?? "127.0.0.1", config)) return null;
  const candidate = findRule(safeDecode(`${input.method ?? "GET"} ${input.path} ${input.body ?? ""}`), config);
  if (!candidate) return null;
  const action: RASPEvent["action"] = candidate.action === "block" && config.mode === "block" ? "blocked" : candidate.action === "alert" ? "alerted" : "logged";
  const event = createRASPEvent(req, candidate, action, input.body ?? "");
  recordEvent(event, config);
  return event;
}
