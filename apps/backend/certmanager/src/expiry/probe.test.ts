import { describe, expect, it, vi } from "vitest";
import type { Socket } from "node:net";
import {
  buildCertStatus,
  probeCertificateWith,
  CertificateProbeError,
  type TlsConnectFn,
} from "./probe.js";
import { CERT_EXPIRY_WARNING_DAYS } from "@delegolabs/types";

const NOW = new Date("2026-09-28T00:00:00Z");

/** Builds a fake TLSSocket whose peer certificate expires in `days`. */
function fakeTls(daysToExpiry: number, options: { noCert?: boolean; malformed?: boolean } = {}) {
  const validTo = new Date(NOW.getTime() + daysToExpiry * 24 * 60 * 60 * 1000);
  const socket = {
    getPeerCertificate: () => {
      if (options.noCert) return {};
      if (options.malformed) return { valid_to: "not-a-date" };
      return { valid_to: validTo.toUTCString() };
    },
    end: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
    setTimeout: vi.fn(),
  } as unknown as Socket;
  return { socket, validTo };
}

function connectFactory(socket: Socket): TlsConnectFn {
  return (_opts, onSecureConnect) => {
    queueMicrotask(onSecureConnect);
    return socket;
  };
}

describe("buildCertStatus", () => {
  it("computes days remaining and flags expiring-soon within the 14-day threshold", () => {
    const validTo = new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000);
    const status = buildCertStatus("shop.example.com", validTo, NOW);
    expect(status).toEqual({
      domain: "shop.example.com",
      validTo,
      daysRemaining: 14,
      isExpiringSoon: true,
    });
  });

  it("is not expiring soon beyond the threshold", () => {
    const validTo = new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000);
    const status = buildCertStatus("shop.example.com", validTo, NOW);
    expect(status.daysRemaining).toBe(60);
    expect(status.isExpiringSoon).toBe(false);
  });

  it("floors partial days (23h left reports 0 days and is expiring soon)", () => {
    const validTo = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);
    const status = buildCertStatus("shop.example.com", validTo, NOW);
    expect(status.daysRemaining).toBe(0);
    expect(status.isExpiringSoon).toBe(true);
  });

  it("reports negative days for expired certificates", () => {
    const validTo = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    const status = buildCertStatus("shop.example.com", validTo, NOW);
    expect(status.daysRemaining).toBe(-3);
    expect(status.isExpiringSoon).toBe(true);
  });

  it("honors a custom warning threshold", () => {
    const validTo = new Date(NOW.getTime() + 29 * 24 * 60 * 60 * 1000);
    const status = buildCertStatus("shop.example.com", validTo, NOW, 30);
    expect(status.isExpiringSoon).toBe(true);
  });

  it("defaults the warning threshold to 14 days", () => {
    expect(CERT_EXPIRY_WARNING_DAYS).toBe(14);
  });
});

describe("probeCertificateWith", () => {
  it("returns CertStatus from the peer certificate", async () => {
    const { socket, validTo } = fakeTls(45);
    const status = await probeCertificateWith(
      "shop.example.com",
      connectFactory(socket),
      { now: () => NOW },
    );
    expect(status.domain).toBe("shop.example.com");
    expect(status.validTo.getTime()).toBe(validTo.getTime());
    expect(status.daysRemaining).toBe(45);
    expect(status.isExpiringSoon).toBe(false);
    expect(socket.end).toHaveBeenCalled();
  });

  it("parses Date-typed valid_to", async () => {
    const validTo = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000);
    const socket = {
      getPeerCertificate: () => ({ valid_to: validTo }),
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      setTimeout: vi.fn(),
    } as unknown as Socket;
    const status = await probeCertificateWith(
      "shop.example.com",
      connectFactory(socket),
      { now: () => NOW },
    );
    expect(status.daysRemaining).toBe(10);
    expect(status.isExpiringSoon).toBe(true);
  });

  it("defaults to the real clock when no override is supplied", async () => {
    const { socket } = fakeTls(3650);
    const status = await probeCertificateWith("shop.example.com", connectFactory(socket), {});
    expect(status.daysRemaining).toBeGreaterThan(3000);
    expect(status.isExpiringSoon).toBe(false);
  });

  it("rejects with NO_CERTIFICATE when the server presents no certificate", async () => {
    const { socket } = fakeTls(30, { noCert: true });
    await expect(
      probeCertificateWith("shop.example.com", connectFactory(socket), {}),
    ).rejects.toThrow(CertificateProbeError);
    await expect(
      probeCertificateWith("shop.example.com", connectFactory(socket), {}),
    ).rejects.toThrow(/did not present a certificate/);
  });

  it("rejects with MALFORMED_CERTIFICATE on unparseable valid_to", async () => {
    const { socket } = fakeTls(30, { malformed: true });
    const err = await probeCertificateWith("shop.example.com", connectFactory(socket), {}).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(CertificateProbeError);
    expect(err.code).toBe("MALFORMED_CERTIFICATE");
  });

  it("rejects with CONNECT_FAILED on socket errors", async () => {
    const socket = {
      on: (_event: string, cb: (err: Error) => void) => {
        queueMicrotask(() => cb(new Error("ECONNREFUSED")));
      },
      destroy: vi.fn(),
      setTimeout: vi.fn(),
    } as unknown as Socket;
    const err = await probeCertificateWith("down.example.com", () => socket, {}).catch((e) => e);
    expect(err).toBeInstanceOf(CertificateProbeError);
    expect(err.code).toBe("CONNECT_FAILED");
    expect(err.domain).toBe("down.example.com");
    expect(err.message).toContain("ECONNREFUSED");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("destroys the socket after a failure", async () => {
    const { socket } = fakeTls(30, { noCert: true });
    await probeCertificateWith("shop.example.com", connectFactory(socket), {}).catch(() => undefined);
    expect(socket.destroy).toHaveBeenCalled();
  });
});
