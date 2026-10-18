import { describe, it, expect, vi, beforeEach } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import {
  validateWebhookUrl,
  isPrivateOrReservedIp,
  createPinnedLookup,
  postJsonWithPinnedIp,
} from "./ssrfGuard.js";

describe("isPrivateOrReservedIp", () => {
  it("blocks the AWS/GCP/Azure cloud-metadata address", () => {
    expect(isPrivateOrReservedIp("169.254.169.254", 4)).toBe(true);
  });

  it("blocks IPv4 loopback", () => {
    expect(isPrivateOrReservedIp("127.0.0.1", 4)).toBe(true);
  });

  it("blocks RFC 1918 private subnets", () => {
    expect(isPrivateOrReservedIp("10.0.0.1", 4)).toBe(true);
    expect(isPrivateOrReservedIp("172.16.5.1", 4)).toBe(true);
    expect(isPrivateOrReservedIp("172.31.255.254", 4)).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.1", 4)).toBe(true);
  });

  it("does not block adjacent public ranges that look similar", () => {
    expect(isPrivateOrReservedIp("172.32.0.1", 4)).toBe(false); // just outside 172.16.0.0/12
    expect(isPrivateOrReservedIp("11.0.0.1", 4)).toBe(false);
  });

  it("allows ordinary public IPv4 addresses", () => {
    expect(isPrivateOrReservedIp("93.184.216.34", 4)).toBe(false);
    expect(isPrivateOrReservedIp("8.8.8.8", 4)).toBe(false);
  });

  it("blocks IPv6 loopback and link-local/unique-local ranges", () => {
    expect(isPrivateOrReservedIp("::1", 6)).toBe(true);
    expect(isPrivateOrReservedIp("fe80::1", 6)).toBe(true);
    expect(isPrivateOrReservedIp("fc00::1", 6)).toBe(true);
    expect(isPrivateOrReservedIp("fd12:3456:789a::1", 6)).toBe(true);
  });

  it("unwraps IPv4-mapped IPv6 addresses before checking", () => {
    expect(isPrivateOrReservedIp("::ffff:169.254.169.254", 6)).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:93.184.216.34", 6)).toBe(false);
  });

  it("allows an ordinary public IPv6 address", () => {
    expect(isPrivateOrReservedIp("2606:2800:220:1:248:1893:25c8:1946", 6)).toBe(false);
  });
});

describe("validateWebhookUrl", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("rejects a plain http:// URL without even resolving DNS", async () => {
    const result = await validateWebhookUrl("http://example.com/hook");
    expect(result).toEqual({ isValid: false, reason: "unsupported_protocol" });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed URL", async () => {
    const result = await validateWebhookUrl("not a url");
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe("unsupported_protocol");
  });

  it("reports dns_resolution_failed when the hostname can't be resolved", async () => {
    lookupMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const result = await validateWebhookUrl("https://nonexistent.invalid/hook");
    expect(result).toEqual({ isValid: false, reason: "dns_resolution_failed" });
  });

  it("blocks a hostname that resolves to the cloud metadata address", async () => {
    lookupMock.mockResolvedValueOnce({ address: "169.254.169.254", family: 4 });
    const result = await validateWebhookUrl("https://attacker-controlled.example/hook");
    expect(result).toEqual({ isValid: false, ipAddress: "169.254.169.254", reason: "private_ip" });
  });

  it("blocks a hostname that resolves to localhost", async () => {
    lookupMock.mockResolvedValueOnce({ address: "127.0.0.1", family: 4 });
    const result = await validateWebhookUrl("https://localhost.example/hook");
    expect(result).toEqual({ isValid: false, ipAddress: "127.0.0.1", reason: "loopback" });
  });

  it("blocks a hostname that resolves into an RFC 1918 private subnet", async () => {
    lookupMock.mockResolvedValueOnce({ address: "10.0.0.1", family: 4 });
    const result = await validateWebhookUrl("https://internal.example/hook");
    expect(result).toEqual({ isValid: false, ipAddress: "10.0.0.1", reason: "private_ip" });
  });

  it("accepts a hostname that resolves to a public IP over HTTPS", async () => {
    lookupMock.mockResolvedValueOnce({ address: "93.184.216.34", family: 4 });
    const result = await validateWebhookUrl("https://merchant-app.example/hook");
    expect(result).toEqual({ isValid: true, ipAddress: "93.184.216.34" });
  });
});

describe("createPinnedLookup", () => {
  it("always returns the pinned address regardless of the hostname looked up", () => {
    const lookup = createPinnedLookup("93.184.216.34", 4);
    const callback = vi.fn();
    lookup("some-other-hostname.example", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });
});

describe("postJsonWithPinnedIp", () => {
  it("refuses to send when validation failed", async () => {
    await expect(
      postJsonWithPinnedIp(
        new URL("https://example.com/hook"),
        { isValid: false, reason: "private_ip" },
        "{}",
        {},
        1000,
      ),
    ).rejects.toThrow(/failed SSRF validation/);
  });
});
