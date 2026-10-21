/**
 * Automated SSL/TLS certificate expiry checking for merchant storefronts
 * (Issue #390).
 *
 * The checker periodically probes every registered merchant domain via a TLS
 * socket probe, computes `CertStatus` (days remaining until expiry), and emits
 * an alert 14 days before expiration. Dedupe keeps active alerts from firing
 * on every tick; the alerter is injectable so tests can assert on emissions.
 */
import type {
  CertExpiryAlert,
  CertExpiryStatus,
  CertExpiryAlerter,
  CertStatus,
  MerchantDomainCertCheck,
} from "@delegolabs/types";
import { CERT_EXPIRY_WARNING_DAYS } from "@delegolabs/types";
import {
  probeCertificateWith,
  type ProbeOptions,
  type TlsConnectFn,
} from "./probe.js";
import { DedupeAlerter } from "./alerter.js";

export interface MerchantDomain {
  merchantId: string;
  domain: string;
}

export interface ExpiryCheckerOptions {
  /** Days before expiry at which an alert fires. Defaults to 14. */
  warningDays?: number;
  alerter: CertExpiryAlerter;
  /** Overrides the clock for deterministic tests. */
  now?: () => Date;
  /** Overrides the TLS connect factory (unit tests); defaults to a real probe. */
  connectTls?: TlsConnectFn;
  /** Extra probe options (port, timeout). */
  probe?: ProbeOptions;
  /** When true, also alerts for expired certificates (default: true). */
  alertOnExpired?: boolean;
}

export interface ExpiryCheckSummary {
  checked: number;
  expiringSoon: number;
  expired: number;
  unreachable: number;
  alertsEmitted: number;
  failures: number;
  results: MerchantDomainCertCheck[];
}

export interface CheckDomainResult {
  result: MerchantDomainCertCheck;
  /** The alert that was emitted, if any. */
  alert?: CertExpiryAlert;
}

/**
 * Registry + runner for merchant storefront certificate expiry checks.
 * Domains are registered via `registerDomain()` (in production this list is
 * seeded from the storefront service's custom-domain records).
 */
export class CertExpiryChecker {
  private readonly domains = new Map<string, MerchantDomain>();
  private readonly alerter: DedupeAlerter;
  private readonly warningDays: number;
  private readonly now: () => Date;
  private readonly connectTls?: TlsConnectFn;
  private readonly probeOptions: ProbeOptions;
  private readonly alertOnExpired: boolean;

  constructor(options: ExpiryCheckerOptions) {
    this.warningDays = options.warningDays ?? CERT_EXPIRY_WARNING_DAYS;
    this.now = options.now ?? (() => new Date());
    this.connectTls = options.connectTls;
    this.probeOptions = options.probe ?? {};
    this.alertOnExpired = options.alertOnExpired ?? true;
    this.alerter = new DedupeAlerter(options.alerter);
  }

  /** Registers a merchant domain for expiry monitoring (idempotent per domain). */
  registerDomain(merchantId: string, domain: string): void {
    this.domains.set(domain.toLowerCase(), { merchantId, domain });
  }

  registerDomains(entries: Array<MerchantDomain | { merchantId: string; domain: string }>): void {
    for (const { merchantId, domain } of entries) {
      this.registerDomain(merchantId, domain);
    }
  }

  listDomains(): MerchantDomain[] {
    return [...this.domains.values()];
  }

  unregisterDomain(domain: string): boolean {
    return this.domains.delete(domain.toLowerCase());
  }

  /** Probes a single domain, computes status, and emits an alert if due. */
  async checkDomain(merchantId: string, domain: string): Promise<CheckDomainResult> {
    const checkedAt = this.now().toISOString();
    const result: MerchantDomainCertCheck = {
      merchantId,
      domain,
      checkedAt,
      status: "unknown",
      alertEmitted: false,
    };

    let status = "ok" as CertExpiryStatus;
    let daysRemaining: number | undefined;
    let validToIso: string | undefined;

    try {
      const certStatus = await this.probe(domain);
      result.certStatus = certStatus;
      daysRemaining = certStatus.daysRemaining;
      validToIso = certStatus.validTo.toISOString();
      status =
        certStatus.daysRemaining < 0
          ? "expired"
          : certStatus.isExpiringSoon
            ? "expiring_soon"
            : "ok";
    } catch (err) {
      result.status = "unreachable";
      result.error = (err as Error).message;
      // An unreachable storefront is also worth alerting on.
      const alert = this.buildAlert(merchantId, domain, "unreachable", undefined, undefined, checkedAt);
      result.alertEmitted = await this.emitAlert(alert);
      return { result, alert: result.alertEmitted ? alert : undefined };
    }

    result.status = status as CertExpiryStatus;

    const shouldAlert =
      (status === "expiring_soon") || (this.alertOnExpired && status === "expired");
    if (!shouldAlert) {
      // Certificate recovered or renewed — clear any active dedupe window.
      this.alerter.clear(domain);
      return { result };
    }

    const alert = this.buildAlert(merchantId, domain, status as CertExpiryStatus, validToIso, daysRemaining, checkedAt);
    result.alertEmitted = await this.emitAlert(alert);
    return { result, alert: result.alertEmitted ? alert : undefined };
  }

  /** Probes every registered domain and returns a summary of the run. */
  async checkAllDomains(): Promise<ExpiryCheckSummary> {
    const summary: ExpiryCheckSummary = {
      checked: 0,
      expiringSoon: 0,
      expired: 0,
      unreachable: 0,
      alertsEmitted: 0,
      failures: 0,
      results: [],
    };

    for (const { merchantId, domain } of this.domains.values()) {
      summary.checked++;
      try {
        const { result } = await this.checkDomain(merchantId, domain);
        summary.results.push(result);
        if (result.status === "expiring_soon") summary.expiringSoon++;
        if (result.status === "expired") summary.expired++;
        if (result.status === "unreachable") summary.unreachable++;
        if (result.alertEmitted) summary.alertsEmitted++;
        if (result.error) summary.failures++;
      } catch (err) {
        // Defensive: checkDomain already traps probe/alert errors, but never
        // let one domain break the whole sweep.
        summary.failures++;
        summary.results.push({
          merchantId,
          domain,
          checkedAt: this.now().toISOString(),
          status: "unknown",
          error: (err as Error).message,
          alertEmitted: false,
        });
      }
    }
    return summary;
  }

  private probe(domain: string): Promise<CertStatus> {
    // Injected transport (tests) or live socket probe — both honor the
    // injected clock and warning threshold so status is deterministic.
    const probeOptions: ProbeOptions = {
      ...this.probeOptions,
      now: this.now,
      warningDays: this.warningDays,
    };
    if (this.connectTls) {
      return probeCertificateWith(domain, this.connectTls, probeOptions);
    }
    return import("./probe.js").then((m) => m.probeCertificate(domain, probeOptions));
  }

  private buildAlert(
    merchantId: string,
    domain: string,
    status: CertExpiryStatus,
    validTo: string | undefined,
    daysRemaining: number | undefined,
    raisedAt: string,
  ): CertExpiryAlert {
    const message =
      status === "unreachable"
        ? `TLS probe for ${domain} failed — storefront may be down or misconfigured`
        : status === "expired"
          ? `Certificate for ${domain} expired ${Math.abs(daysRemaining ?? 0)} day(s) ago (validTo ${validTo})`
          : `Certificate for ${domain} expires in ${daysRemaining} day(s) (validTo ${validTo}) — renew now`;
    return { merchantId, domain, status, validTo, daysRemaining, message, raisedAt };
  }

  private async emitAlert(alert: CertExpiryAlert): Promise<boolean> {
    try {
      // DedupeAlerter resolves false when a repeat alert is suppressed.
      return await this.alerter.emit(alert);
    } catch {
      // Alert delivery failed; the check result still reports probe status.
      return false;
    }
  }
}
