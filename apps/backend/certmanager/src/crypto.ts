import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Git for Windows bundles OpenSSL but does not expose it on PATH. */
const WELL_KNOWN_OPENSSL_PATHS = [
  "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe",
];

/**
 * Locates the OpenSSL binary: `OPENSSL_BIN` wins, then well-known install
 * locations that are missing from PATH, and finally a PATH lookup.
 */
function opensslBinary(): string {
  if (process.env.OPENSSL_BIN) return process.env.OPENSSL_BIN;
  return WELL_KNOWN_OPENSSL_PATHS.find((p) => existsSync(p)) ?? "openssl";
}

function runOpenSsl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(opensslBinary(), args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`openssl failed: ${stderr || err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export interface KeyAndCsr {
  csrPem: string;
  privateKeyPem: string;
}

export interface KeyAndCert {
  certificatePem: string;
  privateKeyPem: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
}

function sanExt(domains: string[]): string {
  return `subjectAltName=${domains.map((d) => `DNS:${d}`).join(",")}`;
}

/**
 * Generates an RSA key pair and a PKCS#10 CSR covering every requested domain
 * (including wildcards). The CSR is what gets submitted to the ACME finalize
 * step. Uses the system `openssl` binary.
 */
export async function generateCsr(domains: string[]): Promise<KeyAndCsr> {
  const id = randomBytes(6).toString("hex");
  const keyPath = join(tmpdir(), `cm-key-${id}.pem`);
  try {
    await runOpenSsl(["genrsa", "-out", keyPath, "2048"]);
    const privateKeyPem = await fs.readFile(keyPath, "utf8");
    const csrPem = await runOpenSsl([
      "req",
      "-new",
      "-key",
      keyPath,
      "-subj",
      `/CN=${domains[0]}`,
      "-addext",
      sanExt(domains),
    ]);
    return { csrPem, privateKeyPem };
  } finally {
    await fs.unlink(keyPath).catch(() => undefined);
  }
}

/**
 * Produces a self-signed certificate for the requested domains. Used by the
 * offline/stub ACME client so the full issuance lifecycle can be exercised
 * locally without reaching a public CA.
 */
export async function generateSelfSigned(domains: string[]): Promise<KeyAndCert> {
  const id = randomBytes(6).toString("hex");
  const keyPath = join(tmpdir(), `cm-key-${id}.pem`);
  const certPath = join(tmpdir(), `cm-cert-${id}.pem`);
  try {
    await runOpenSsl(["genrsa", "-out", keyPath, "2048"]);
    const privateKeyPem = await fs.readFile(keyPath, "utf8");
    await runOpenSsl([
      "req",
      "-x509",
      "-new",
      "-nodes",
      "-key",
      keyPath,
      "-sha256",
      "-days",
      "90",
      "-out",
      certPath,
      "-subj",
      `/CN=${domains[0]}`,
      "-addext",
      sanExt(domains),
    ]);
    const certificatePem = await fs.readFile(certPath, "utf8");
    const serialNumber = (
      await runOpenSsl(["x509", "-in", certPath, "-noout", "-serial"])
    )
      .trim()
      .replace(/^serial=/, "");
    const dates = await runOpenSsl(["x509", "-in", certPath, "-noout", "-startdate", "-enddate"]);
    const notBefore = parseOpenSslDate(dates, "notBefore=");
    const notAfter = parseOpenSslDate(dates, "notAfter=");
    return { certificatePem, privateKeyPem, serialNumber, notBefore, notAfter };
  } finally {
    await fs.unlink(keyPath).catch(() => undefined);
    await fs.unlink(certPath).catch(() => undefined);
  }
}

function parseOpenSslDate(output: string, prefix: string): string {
  const line = output.split("\n").find((l) => l.startsWith(prefix));
  if (!line) return new Date().toISOString();
  // OpenSSL prints "Mon DD HH:MM:SS YYYY GMT"; convert to ISO.
  const date = new Date(line.slice(prefix.length).trim());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function generateId(): string {
  return `cert_${randomBytes(12).toString("hex")}`;
}
