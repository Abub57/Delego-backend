import { isIP } from "node:net";
import * as tls from "node:tls";
import type { AuditLogEntry } from "./types.js";

export type AuditLogTransport = (entry: AuditLogEntry) => void | Promise<void>;

export interface CefSyslogOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  ca?: string | Buffer;
}

function escapeHeader(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function escapeExtension(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/=/g, "\\=")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function extension(key: string, value: string | number | null): string | null {
  return value === null || value === "" ? null : `${key}=${escapeExtension(String(value))}`;
}

export function formatCef(entry: AuditLogEntry): string {
  const header = [
    "CEF:0",
    "DelegoLabs",
    "Delego",
    "1.0",
    entry.operation,
    `${entry.operation} audit event`,
    "5",
  ].map((part, index) => index === 0 ? part : escapeHeader(part));

  const fields = [
    extension("eventId", entry.id),
    extension("sequenceNum", entry.sequenceNum),
    extension("suser", entry.userId),
    extension("src", entry.ipAddress),
    extension("cs1Label", "tableName"),
    extension("cs1", entry.tableName),
    extension("cs2Label", "recordId"),
    extension("cs2", entry.recordId),
    extension("cs3Label", "changedFields"),
    extension("cs3", entry.changedFields.join(",")),
    extension("rt", entry.occurredAt.getTime()),
    extension("externalId", entry.transactionId),
    extension("deviceCustomString1Label", "entryHash"),
    extension("deviceCustomString1", entry.entryHash),
    extension("deviceCustomString2Label", "previousEntryHash"),
    extension("deviceCustomString2", entry.prevHash),
  ].filter((field): field is string => field !== null);

  return `${header.join("|")}|${fields.join(" ")}`;
}

export function createCefSyslogTransport(
  options: CefSyslogOptions,
  connect: typeof tls.connect = tls.connect
): AuditLogTransport {
  const timeoutMs = options.timeoutMs ?? 5_000;

  return (entry) => new Promise<void>((resolve, reject) => {
    const socket = connect({
      host: options.host,
      port: options.port,
      rejectUnauthorized: true,
      servername: isIP(options.host) ? undefined : options.host,
      checkServerIdentity: (_servername, certificate) => tls.checkServerIdentity(options.host, certificate),
      ...(options.ca ? { ca: options.ca } : {}),
    });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(timeoutMs, () => fail(new Error("CEF Syslog TLS connection timed out")));
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      socket.end(`${formatCef(entry)}\n`, () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  });
}

let auditLogTransport: AuditLogTransport | undefined;

export function configureAuditLogTransport(transport?: AuditLogTransport): void {
  auditLogTransport = transport;
}

export function dispatchAuditLogEntry(entry: AuditLogEntry): void {
  if (!auditLogTransport) return;
  try {
    void Promise.resolve(auditLogTransport(entry)).catch(() => undefined);
  } catch {
    // An external SIEM outage must not roll back or hide a committed audit entry.
  }
}