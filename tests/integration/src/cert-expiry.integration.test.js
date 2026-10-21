/**
 * Integration test (Issue #390) — probes a real TLS server end-to-end.
 *
 * Spins up an HTTPS server with a self-signed certificate generated via the
 * system openssl binary (same mechanism as certmanager's stub ACME client),
 * then runs the live socket probe and the full CertExpiryChecker against it.
 * Skipped when openssl is unavailable.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const CERTMANAGER_DIST = "../../../apps/backend/certmanager/dist/src/expiry";
const { probeCertificate } = await import(`${CERTMANAGER_DIST}/probe.js`);
const { CertExpiryChecker } = await import(`${CERTMANAGER_DIST}/checker.js`);
const { ExpiryScheduler } = await import(`${CERTMANAGER_DIST}/scheduler.js`);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const opensslAvailable = await new Promise((resolve) => {
  execFile("openssl", ["version"], (err) => resolve(!err));
});

describe("cert expiry checker against a live TLS server", { skip: !opensslAvailable }, () => {
  /** HTTPS server hosting the self-signed cert under test. */
  let server = null;
  let port = 0;
  const cleanupFiles = [];

  before(async () => {
    const id = randomBytes(6).toString("hex");
    const keyPath = join(tmpdir(), `expiry-it-key-${id}.pem`);
    const certPath = join(tmpdir(), `expiry-it-cert-${id}.pem`);
    cleanupFiles.push(keyPath, certPath);

    // Self-signed cert for 127.0.0.1 valid for 60 days (far from the 14-day
    // default threshold — tests override `warningDays` when they need an alert).
    await new Promise((resolve, reject) => {
      execFile(
        "openssl",
        [
          "req", "-x509", "-newkey", "rsa:2048", "-nodes",
          "-keyout", keyPath, "-out", certPath,
          "-days", "60", "-subj", "/CN=127.0.0.1",
          "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
        ],
        (err) => (err ? reject(err) : resolve(undefined)),
      );
    });

    const [key, cert] = await Promise.all([
      fs.readFile(keyPath, "utf8"),
      fs.readFile(certPath, "utf8"),
    ]);

    const { createServer: createHttpsServer } = await import("node:https");
    server = createHttpsServer({ key, cert }, (_req, res) => res.end("ok"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  after(async () => {
    server?.close();
    await Promise.all(cleanupFiles.map((f) => fs.unlink(f).catch(() => undefined)));
  });

  function checkerWithLocalPort(alerter, warningDays = 14) {
    const checker = new CertExpiryChecker({ alerter, warningDays });
    checker.registerDomain("merchant-live", "127.0.0.1");
    // Point the probe at the local test server's port.
    checker.probeOptions = { port, servername: "localhost", timeoutMs: 5000 };
    return checker;
  }

  it("probes the live server and reports a valid, far-from-expiry cert", async () => {
    const status = await probeCertificate("127.0.0.1", {
      port,
      servername: "localhost",
      timeoutMs: 5000,
    });
    assert.equal(status.domain, "127.0.0.1");
    // Cert was minted for 60 days moments ago.
    assert.ok(
      status.daysRemaining >= 58 && status.daysRemaining <= 60,
      `daysRemaining=${status.daysRemaining}`,
    );
    assert.equal(status.isExpiringSoon, false);
    assert.ok(status.validTo.getTime() > Date.now());
  });

  it("computes status through CertExpiryChecker and emits no alert while healthy", async () => {
    const alerts = [];
    const checker = checkerWithLocalPort({
      emit: async (a) => (alerts.push(a), true),
    });

    const summary = await checker.checkAllDomains();
    assert.equal(summary.checked, 1);
    assert.equal(summary.results[0].status, "ok");
    assert.equal(summary.alertsEmitted, 0);
    assert.equal(alerts.length, 0);
    assert.ok(summary.results[0].certStatus);
    assert.equal(summary.results[0].certStatus.domain, "127.0.0.1");
    assert.ok(summary.results[0].certStatus.daysRemaining >= 58);
  });

  it("flags expiring_soon and emits an alert when the threshold is crossed", async () => {
    const alerts = [];
    // Force the freshly minted 60-day cert over the threshold.
    const checker = checkerWithLocalPort(
      { emit: async (a) => (alerts.push(a), true) },
      90,
    );

    const { result } = await checker.checkDomain("merchant-live", "127.0.0.1");
    assert.equal(result.status, "expiring_soon");
    assert.equal(result.alertEmitted, true);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].status, "expiring_soon");
    assert.ok(alerts[0].message.includes("renew now"));
  });

  it("reports unreachable and alerts when the port refuses connections", async () => {
    const alerts = [];
    const checker = new CertExpiryChecker({
      alerter: { emit: async (a) => (alerts.push(a), true) },
    });
    checker.registerDomain("merchant-dead", "127.0.0.1");
    checker.probeOptions = { port: 1, timeoutMs: 2000 }; // nothing listens here

    const summary = await checker.checkAllDomains();
    assert.equal(summary.checked, 1);
    assert.equal(summary.unreachable, 1);
    assert.equal(summary.alertsEmitted, 1);
    assert.equal(alerts[0].status, "unreachable");
  });

  it("sweeps on a scheduler tick without emitting for healthy certs", async () => {
    const alerts = [];
    const checker = checkerWithLocalPort({
      emit: async (a) => (alerts.push(a), true),
    });
    const scheduler = new ExpiryScheduler(checker);
    const summary = await scheduler.tick();
    scheduler.stop();
    assert.equal(summary.checked, 1);
    assert.equal(alerts.length, 0);
  });
});
