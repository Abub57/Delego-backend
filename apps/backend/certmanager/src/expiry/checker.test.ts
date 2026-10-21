import { describe, expect, it, vi } from "vitest";
import type { Socket } from "node:net";
import type { CertExpiryAlerter } from "@delegolabs/types";
import { CertExpiryChecker } from "./checker.js";
import type { TlsConnectFn } from "./probe.js";

const NOW = new Date("2026-09-28T00:00:00Z");

function collectingAlerter() {
  const emitted: Array<Record<string, unknown>> = [];
  const alerter: CertExpiryAlerter = {
    emit: async (a) => {
      emitted.push(a as unknown as Record<string, unknown>);
      return true;
    },
  };
  return { emitted, alerter };
}

/** Fake TLS transport whose certificate expires in `daysToExpiry` days. */
function fakeConnect(
  daysToExpiry: number,
  overrides: { reject?: Error; noCert?: boolean } = {},
): TlsConnectFn {
  return (_opts, onSecureConnect) => {
    // When `reject` is set, the socket errors instead of completing the TLS
    // handshake — secureConnect must never fire (mirrors node:tls behavior).
    if (overrides.reject) {
      const errSocket = {
        on: (_event: string, cb: (err: Error) => void) => {
          queueMicrotask(() => cb(overrides.reject!));
        },
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      } as unknown as Socket;
      return errSocket;
    }
    const socket = {
      getPeerCertificate: () => {
        if (overrides.noCert) return {};
        return {
          valid_to: new Date(NOW.getTime() + daysToExpiry * 24 * 60 * 60 * 1000).toUTCString(),
        };
      },
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      setTimeout: vi.fn(),
    } as unknown as Socket;
    queueMicrotask(onSecureConnect);
    return socket;
  };
}

function makeChecker(
  connectTls: TlsConnectFn,
  alerter: CertExpiryAlerter,
  options: { warningDays?: number; alertOnExpired?: boolean } = {},
) {
  return new CertExpiryChecker({
    alerter,
    now: () => NOW,
    connectTls,
    warningDays: options.warningDays,
    alertOnExpired: options.alertOnExpired,
  });
}

describe("CertExpiryChecker.checkDomain", () => {
  it("reports ok with daysRemaining when the cert is healthy", async () => {
    const { emitted, alerter } = collectingAlerter();
    const checker = makeChecker(fakeConnect(60), alerter);
    const { result } = await checker.checkDomain("m1", "shop.example.com");
    expect(result.status).toBe("ok");
    expect(result.certStatus?.daysRemaining).toBe(60);
    expect(result.certStatus?.isExpiringSoon).toBe(false);
    expect(result.alertEmitted).toBe(false);
    expect(result.error).toBeUndefined();
    expect(emitted).toHaveLength(0);
  });

  it("emits an alert when the cert is within the 14-day threshold", async () => {
    const { emitted, alerter } = collectingAlerter();
    const checker = makeChecker(fakeConnect(10), alerter);
    const { result, alert } = await checker.checkDomain("m1", "shop.example.com");
    expect(result.status).toBe("expiring_soon");
    expect(result.certStatus?.daysRemaining).toBe(10);
    expect(result.certStatus?.isExpiringSoon).toBe(true);
    expect(result.alertEmitted).toBe(true);
    expect(alert?.status).toBe("expiring_soon");
    expect(alert?.domain).toBe("shop.example.com");
    expect(alert?.merchantId).toBe("m1");
    expect(alert?.daysRemaining).toBe(10);
    expect(alert?.message).toContain("renew now");
    expect(emitted).toHaveLength(1);
  });

  it("flags the boundary day (exactly 14 days left) as expiring soon", async () => {
    const { alerter } = collectingAlerter();
    const checker = makeChecker(fakeConnect(14), alerter);
    const { result } = await checker.checkDomain("m1", "shop.example.com");
    expect(result.status).toBe("expiring_soon");
  });

  it("emits an alert for an expired certificate", async () => {
    const { emitted, alerter } = collectingAlerter();
    const checker = makeChecker(fakeConnect(-2), alerter);
    const { result, alert } = await checker.checkDomain("m1", "shop.example.com");
    expect(result.status).toBe("expired");
    expect(result.alertEmitted).toBe(true);
    expect(alert?.status).toBe("expired");
    expect(alert?.message).toContain("expired 2 day(s) ago");
    expect(emitted).toHaveLength(1);
  });

  it("reports unreachable and alerts when the probe fails", async () => {
    const { emitted, alerter } = collectingAlerter();
    const checker = makeChecker(fakeConnect(30, { reject: new Error("ECONNREFUSED") }), alerter);
    const { result, alert } = await checker.checkDomain("m1", "shop.example.com");
    expect(result.status).toBe("unreachable");
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.certStatus).toBeUndefined();
    expect(result.alertEmitted).toBe(true);
    expect(alert?.status).toBe("unreachable");
    expect(alert?.message).toContain("storefront may be down");
    expect(emitted).toHaveLength(1);
  });

  it("respects a custom warning threshold", async () => {
    const { emitted, alerter } = collectingAlerter();
    const checker = makeChecker(fakeConnect(20), alerter, { warningDays: 30 });
    const { result } = await checker.checkDomain("m1", "shop.example.com");
    expect(result.status).toBe("expiring_soon");
    expect(emitted).toHaveLength(1);
  });

  it("can disable alerts for expired certificates", async () => {
    const { emitted, alerter } = collectingAlerter();
    const checker = makeChecker(fakeConnect(-5), alerter, { alertOnExpired: false });
    const { result } = await checker.checkDomain("m1", "shop.example.com");
    expect(result.status).toBe("expired");
    expect(result.alertEmitted).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it("does not alert twice for the same domain in one run (dedupe)", async () => {
    const { emitted, alerter } = collectingAlerter();
    const checker = makeChecker(fakeConnect(10), alerter);
    await checker.checkDomain("m1", "shop.example.com");
    const { result } = await checker.checkDomain("m1", "shop.example.com");
    expect(result.status).toBe("expiring_soon");
    expect(result.alertEmitted).toBe(false);
    expect(emitted).toHaveLength(1);
  });

  it("clears dedupe and re-alerts after the certificate is renewed", async () => {
    const { emitted, alerter } = collectingAlerter();
    let days = 10;
    const checker = makeChecker((opts, cb) => fakeConnect(days)(opts, cb), alerter);
    await checker.checkDomain("m1", "shop.example.com");
    // Cert renewed with 60 days of validity.
    days = 60;
    const { result } = await checker.checkDomain("m1", "shop.example.com");
    expect(result.status).toBe("ok");
    expect(result.alertEmitted).toBe(false);
    // Drop below the threshold again after renewal.
    days = 8;
    const second = await checker.checkDomain("m1", "shop.example.com");
    expect(second.result.alertEmitted).toBe(true);
    expect(emitted).toHaveLength(2);
  });

  it("keeps alertEmitted false when the alert sink fails", async () => {
    const failing: CertExpiryAlerter = {
      emit: async () => {
        throw new Error("sink down");
      },
    };
    const checker = makeChecker(fakeConnect(10), failing);
    const { result } = await checker.checkDomain("m1", "shop.example.com");
    expect(result.status).toBe("expiring_soon");
    expect(result.alertEmitted).toBe(false);
  });

  it("keeps alertEmitted false when the sink suppresses the alert as a duplicate", async () => {
    const suppressing: CertExpiryAlerter = {
      emit: async () => false,
    };
    const checker = makeChecker(fakeConnect(10), suppressing);
    const { result } = await checker.checkDomain("m1", "shop.example.com");
    expect(result.status).toBe("expiring_soon");
    expect(result.alertEmitted).toBe(false);
  });
});

describe("CertExpiryChecker registry", () => {
  it("registers domains idempotently (case-insensitive)", () => {
    const { alerter } = collectingAlerter();
    const checker = makeChecker(fakeConnect(30), alerter);
    checker.registerDomain("m1", "Shop.Example.com");
    checker.registerDomain("m2", "shop.example.com");
    expect(checker.listDomains()).toHaveLength(1);
    expect(checker.listDomains()[0].merchantId).toBe("m2");
  });

  it("registers multiple domains in bulk", () => {
    const { alerter } = collectingAlerter();
    const checker = makeChecker(fakeConnect(30), alerter);
    checker.registerDomains([
      { merchantId: "m1", domain: "a.example.com" },
      { merchantId: "m2", domain: "b.example.com" },
    ]);
    expect(checker.listDomains()).toHaveLength(2);
  });

  it("unregisters domains", () => {
    const { alerter } = collectingAlerter();
    const checker = makeChecker(fakeConnect(30), alerter);
    checker.registerDomain("m1", "shop.example.com");
    expect(checker.unregisterDomain("shop.example.com")).toBe(true);
    expect(checker.unregisterDomain("shop.example.com")).toBe(false);
    expect(checker.listDomains()).toHaveLength(0);
  });
});

describe("CertExpiryChecker.checkAllDomains", () => {
  it("sweeps every registered domain and summarizes the results", async () => {
    const { emitted, alerter } = collectingAlerter();
    const checker = new CertExpiryChecker({
      alerter,
      now: () => NOW,
      connectTls: (opts, cb) => {
        const host = (opts as { host: string }).host;
        const days = host.startsWith("healthy.") ? 60 : host.startsWith("soon.") ? 7 : -1;
        return fakeConnect(days)(opts, cb);
      },
    });
    checker.registerDomains([
      { merchantId: "m1", domain: "healthy.example.com" },
      { merchantId: "m2", domain: "soon.example.com" },
      { merchantId: "m3", domain: "expired.example.com" },
    ]);

    const summary = await checker.checkAllDomains();
    expect(summary.checked).toBe(3);
    expect(summary.expiringSoon).toBe(1);
    expect(summary.expired).toBe(1);
    expect(summary.unreachable).toBe(0);
    expect(summary.alertsEmitted).toBe(2);
    expect(summary.failures).toBe(0);
    expect(summary.results).toHaveLength(3);
    expect(emitted).toHaveLength(2);
  });

  it("counts unreachable domains and continues the sweep", async () => {
    const { alerter } = collectingAlerter();
    const checker = new CertExpiryChecker({
      alerter,
      now: () => NOW,
      connectTls: (opts, cb) =>
        fakeConnect(30, {
          reject: new Error((opts as { host: string }).host),
        })(opts, cb),
    });
    checker.registerDomains([
      { merchantId: "m1", domain: "down1.example.com" },
      { merchantId: "m2", domain: "down2.example.com" },
    ]);
    const summary = await checker.checkAllDomains();
    expect(summary.checked).toBe(2);
    expect(summary.unreachable).toBe(2);
    expect(summary.failures).toBe(2);
    expect(summary.alertsEmitted).toBe(2);
    expect(summary.results.every((r) => r.status === "unreachable")).toBe(true);
  });

  it("returns an empty summary when no domains are registered", async () => {
    const { alerter } = collectingAlerter();
    const checker = makeChecker(fakeConnect(30), alerter);
    const summary = await checker.checkAllDomains();
    expect(summary.checked).toBe(0);
    expect(summary.results).toHaveLength(0);
  });
});
