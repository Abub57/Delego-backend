/**
 * Certificate expiry alert sinks (Issue #390).
 *
 * Alerts fire when a merchant storefront certificate is within the warning
 * threshold of expiry (14 days). Dedupe prevents a domain from re-alerting on
 * every scheduler tick while the alert is still active.
 */
import { createLogger } from "@delegolabs/utils";
import type { CertExpiryAlert, CertExpiryAlerter } from "@delegolabs/types";

const log = createLogger("certmanager:expiry", process.env.LOG_LEVEL ?? "info");

/**
 * Suppresses repeat alerts for the same domain while the previous alert is
 * still active. Dedupe keys expire after `ttlMs` (or when `clear` is called,
 * e.g. after a cert is renewed and is no longer expiring soon).
 */
export class DedupeAlerter implements CertExpiryAlerter {
  private readonly lastEmitted = new Map<string, number>();

  constructor(
    private readonly inner: CertExpiryAlerter,
    private readonly ttlMs: number = 24 * 60 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async emit(alert: CertExpiryAlert): Promise<boolean> {
    const key = alert.domain;
    const emittedAt = this.lastEmitted.get(key);
    if (emittedAt !== undefined && this.now() - emittedAt < this.ttlMs) {
      log.debug("suppressing duplicate cert expiry alert", { domain: alert.domain });
      return false;
    }
    const delivered = await this.inner.emit(alert);
    if (delivered) {
      this.lastEmitted.set(key, this.now());
    }
    return delivered;
  }

  /** Clears dedupe state for a domain (call when the cert renews or recovers). */
  clear(domain: string): void {
    this.lastEmitted.delete(domain);
  }

  clearAll(): void {
    this.lastEmitted.clear();
  }
}

/** Sink that writes the alert to the service log. Always available. */
export class LoggingCertExpiryAlerter implements CertExpiryAlerter {
  async emit(alert: CertExpiryAlert): Promise<boolean> {
    const level = alert.status === "expired" || alert.status === "unreachable" ? "error" : "warn";
    log[level === "error" ? "error" : "warn"]("certificate expiry alert", {
      merchantId: alert.merchantId,
      domain: alert.domain,
      status: alert.status,
      validTo: alert.validTo,
      daysRemaining: alert.daysRemaining,
      message: alert.message,
    });
    return true;
  }
}

/**
 * Sink that POSTs the alert to an HTTPS webhook. Failures are surfaced to the
 * caller so the scheduler can record them; the fetch implementation is
 * injectable for tests.
 */
export class WebhookCertExpiryAlerter implements CertExpiryAlerter {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async emit(alert: CertExpiryAlert): Promise<boolean> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(alert),
    });
    if (!res.ok) {
      throw new Error(`cert expiry webhook alert failed (${this.url}): ${res.status}`);
    }
    return true;
  }
}

/** Composite sink; every sink is attempted even if one fails. */
export class CompositeCertExpiryAlerter implements CertExpiryAlerter {
  constructor(private readonly alerters: CertExpiryAlerter[]) {}

  async emit(alert: CertExpiryAlert): Promise<boolean> {
    const failures: string[] = [];
    let delivered = false;
    for (const alerter of this.alerters) {
      try {
        if (await alerter.emit(alert)) delivered = true;
      } catch (err) {
        failures.push((err as Error).message);
      }
    }
    if (failures.length > 0) {
      throw new Error(`one or more alert sinks failed: ${failures.join("; ")}`);
    }
    return delivered;
  }
}

export function createCertExpiryAlerter(options: {
  webhookUrl?: string;
  fetchImpl?: typeof fetch;
}): CertExpiryAlerter {
  const sinks: CertExpiryAlerter[] = [new LoggingCertExpiryAlerter()];
  if (options.webhookUrl) {
    sinks.push(new WebhookCertExpiryAlerter(options.webhookUrl, options.fetchImpl));
  }
  return new CompositeCertExpiryAlerter(sinks);
}
