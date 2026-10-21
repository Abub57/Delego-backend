/**
 * TLS certificate socket probe (Issue #390).
 *
 * Connects to a merchant storefront domain over TLS, inspects the certificate
 * the server presents, and computes expiry information. The socket factory is
 * injectable so unit tests can exercise probe logic without a network.
 */
import { type TcpSocketConnectOpts, type Socket } from "node:net";
import type { CertStatus } from "@delegolabs/types";
import { CERT_EXPIRY_WARNING_DAYS } from "@delegolabs/types";

export const DEFAULT_TLS_PORT = 443;
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface ProbeOptions {
  port?: number;
  timeoutMs?: number;
  servername?: string;
  /** Overrides the clock for deterministic tests. */
  now?: () => Date;
  /** Days-before-expiry threshold; defaults to CERT_EXPIRY_WARNING_DAYS. */
  warningDays?: number;
  /**
   * Whether to enforce chain/host validation during the handshake. Defaults
   * to false: an expiry checker must still be able to read certificates that
   * fail validation (self-signed, broken chain, wrong host) — that is often
   * exactly when an alert is needed.
   */
  rejectUnauthorized?: boolean;
}

export class CertificateProbeError extends Error {
  readonly domain: string;
  readonly code: string;

  constructor(domain: string, code: string, message: string) {
    super(`TLS probe failed for ${domain}: ${message}`);
    this.name = "CertificateProbeError";
    this.domain = domain;
    this.code = code;
  }
}

/** Minimal peer-certificate shape we rely on (subset of tls.PeerCertificate). */
export interface PeerCertificateLike {
  valid_to: string | Date;
}

export type TlsConnectFn = (
  options: Record<string, unknown>,
  onSecureConnect: () => void,
) => Socket;

/**
 * Inspects the TLS certificate presented by `domain` via a live socket probe.
 * Resolves with a `CertStatus` describing expiry and the days remaining.
 */
export async function probeCertificate(
  domain: string,
  options: ProbeOptions = {},
): Promise<CertStatus> {
  const tls = await import("node:tls");
  const connectTls: TlsConnectFn = (opts, onSecureConnect) =>
    tls.connect(opts as unknown as TcpSocketConnectOpts, onSecureConnect);
  return probeCertificateWith(domain, connectTls, options);
}

/**
 * Testable core of `probeCertificate`: performs the probe through the supplied
 * `connectTls` factory (mirroring `tls.connect(options, secureConnectListener)`).
 */
export function probeCertificateWith(
  domain: string,
  connectTls: TlsConnectFn,
  options: ProbeOptions = {},
): Promise<CertStatus> {
  const port = options.port ?? DEFAULT_TLS_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  return new Promise<CertStatus>((resolve, reject) => {
    let settled = false;

    const fail = (code: string, message: string) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      reject(new CertificateProbeError(domain, code, message));
    };

    let socket: Socket | null = null;
    try {
      socket = connectTls(
        {
          host: domain,
          port,
          servername: options.servername ?? domain,
          rejectUnauthorized: options.rejectUnauthorized ?? false,
        },
        () => {
        if (settled) return;
        const cert = (socket as import("node:tls").TLSSocket).getPeerCertificate();
        if (!cert || Object.keys(cert).length === 0) {
          fail("NO_CERTIFICATE", "server did not present a certificate");
          return;
        }
        const validToRaw: unknown = cert.valid_to;
        const validTo = validToRaw instanceof Date ? validToRaw : new Date(validToRaw as string);
        if (Number.isNaN(validTo.getTime())) {
          fail("MALFORMED_CERTIFICATE", `unparseable valid_to: ${String(cert.valid_to)}`);
          return;
        }
        settled = true;
        socket?.end();
        resolve(buildCertStatus(domain, validTo, now(), options.warningDays));
      });
    } catch (err) {
      fail("CONNECT_FAILED", (err as Error).message);
      return;
    }

    socket.on("error", (err: Error) => {
      fail("CONNECT_FAILED", err.message);
    });
    socket.setTimeout(timeoutMs, () => {
      fail("TIMEOUT", `no response within ${timeoutMs}ms`);
    });
  });
}

/**
 * Computes a `CertStatus` (days remaining + expiring-soon flag) from a
 * certificate expiry date. Days are floored so "expires later today" reports
 * 0 days, and negative values mark already-expired certificates.
 */
export function buildCertStatus(
  domain: string,
  validTo: Date,
  now: Date = new Date(),
  warningDays: number = CERT_EXPIRY_WARNING_DAYS,
): CertStatus {
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.floor((validTo.getTime() - now.getTime()) / msPerDay);
  return {
    domain,
    validTo,
    daysRemaining,
    isExpiringSoon: daysRemaining <= warningDays,
  };
}
