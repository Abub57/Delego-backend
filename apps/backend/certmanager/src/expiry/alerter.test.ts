import { describe, expect, it, vi } from "vitest";
import type { CertExpiryAlert, CertExpiryAlerter } from "@delegolabs/types";
import {
  CompositeCertExpiryAlerter,
  DedupeAlerter,
  LoggingCertExpiryAlerter,
  WebhookCertExpiryAlerter,
  createCertExpiryAlerter,
} from "./alerter.js";

const alert: CertExpiryAlert = {
  merchantId: "m1",
  domain: "shop.example.com",
  status: "expiring_soon",
  validTo: new Date("2026-10-10T00:00:00Z").toISOString(),
  daysRemaining: 12,
  message: "expires in 12 day(s)",
  raisedAt: new Date("2026-09-28T00:00:00Z").toISOString(),
};

function collectingAlerter() {
  const emitted: CertExpiryAlert[] = [];
  const alerter: CertExpiryAlerter = {
    emit: async (a) => {
      emitted.push(a);
      return true;
    },
  };
  return { emitted, alerter };
}

describe("DedupeAlerter", () => {
  it("passes the first alert through", async () => {
    const { emitted, alerter } = collectingAlerter();
    const dedupe = new DedupeAlerter(alerter);
    await dedupe.emit(alert);
    expect(emitted).toHaveLength(1);
  });

  it("suppresses a repeat alert for the same domain within the TTL", async () => {
    const { emitted, alerter } = collectingAlerter();
    let clock = 0;
    const dedupe = new DedupeAlerter(alerter, 24 * 60 * 60 * 1000, () => clock);
    await expect(dedupe.emit(alert)).resolves.toBe(true);
    clock += 1000;
    await expect(dedupe.emit(alert)).resolves.toBe(false);
    expect(emitted).toHaveLength(1);
  });

  it("re-emits after the TTL elapses", async () => {
    const { emitted, alerter } = collectingAlerter();
    let clock = 0;
    const ttl = 1000;
    const dedupe = new DedupeAlerter(alerter, ttl, () => clock);
    await dedupe.emit(alert);
    clock += ttl + 1;
    await dedupe.emit(alert);
    expect(emitted).toHaveLength(2);
  });

  it("dedupes per domain, not globally", async () => {
    const { emitted, alerter } = collectingAlerter();
    const dedupe = new DedupeAlerter(alerter);
    await dedupe.emit(alert);
    await dedupe.emit({ ...alert, domain: "other.example.com" });
    expect(emitted).toHaveLength(2);
  });

  it("clear() allows the next alert through immediately", async () => {
    const { emitted, alerter } = collectingAlerter();
    const dedupe = new DedupeAlerter(alerter, 24 * 60 * 60 * 1000);
    await dedupe.emit(alert);
    dedupe.clear(alert.domain);
    await dedupe.emit(alert);
    expect(emitted).toHaveLength(2);
  });
});

describe("LoggingCertExpiryAlerter", () => {
  it("emits and reports delivery", async () => {
    const sink = new LoggingCertExpiryAlerter();
    await expect(sink.emit(alert)).resolves.toBe(true);
  });
});

describe("WebhookCertExpiryAlerter", () => {
  it("POSTs the alert payload to the configured URL", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const sink = new WebhookCertExpiryAlerter("https://hooks.example.com/cert", fetchImpl);
    await sink.emit(alert);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hooks.example.com/cert",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.domain).toBe("shop.example.com");
    expect(body.daysRemaining).toBe(12);
  });

  it("throws on non-2xx responses", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const sink = new WebhookCertExpiryAlerter("https://hooks.example.com/cert", fetchImpl);
    await expect(sink.emit(alert)).rejects.toThrow(/webhook alert failed/);
  });
});

describe("CompositeCertExpiryAlerter", () => {
  it("invokes every sink", async () => {
    const first = collectingAlerter();
    const second = collectingAlerter();
    const composite = new CompositeCertExpiryAlerter([first.alerter, second.alerter]);
    await composite.emit(alert);
    expect(first.emitted).toHaveLength(1);
    expect(second.emitted).toHaveLength(1);
  });

  it("attempts all sinks even when one fails, then reports the failure", async () => {
    const good = collectingAlerter();
    const bad: CertExpiryAlerter = {
      emit: async () => {
        throw new Error("sink down");
      },
    };
    const third = collectingAlerter();
    const composite = new CompositeCertExpiryAlerter([good.alerter, bad, third.alerter]);
    await expect(composite.emit(alert)).rejects.toThrow(/sink down/);
    expect(good.emitted).toHaveLength(1);
    expect(third.emitted).toHaveLength(1);
  });
});

describe("createCertExpiryAlerter", () => {
  it("always includes the logging sink", async () => {
    const alerter = createCertExpiryAlerter({});
    await expect(alerter.emit(alert)).resolves.toBe(true);
  });

  it("adds a webhook sink when a URL is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const alerter = createCertExpiryAlerter({
      webhookUrl: "https://hooks.example.com/cert",
      fetchImpl,
    });
    await alerter.emit(alert);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
