import { describe, it, expect } from "vitest";
import { maskPii, maskPiiDeep, containsPii, PII_REDACTION_PLACEHOLDER } from "./piiMasking.js";

describe("maskPii", () => {
  it("redacts email addresses", () => {
    const masked = maskPii("contact buyer at jane.doe@example.com for support");
    expect(masked).not.toContain("jane.doe@example.com");
    expect(masked).toContain(PII_REDACTION_PLACEHOLDER);
  });

  it("redacts phone numbers", () => {
    const masked = maskPii("recipient phone: 15551234567");
    expect(masked).not.toContain("15551234567");
    expect(masked).toContain(PII_REDACTION_PLACEHOLDER);
  });

  it("redacts credit card numbers", () => {
    const masked = maskPii("card on file 4111 1111 1111 1111 expires soon");
    expect(masked).not.toContain("4111 1111 1111 1111");
    expect(masked).toContain(PII_REDACTION_PLACEHOLDER);
  });

  it("redacts stellar secret keys", () => {
    const secret = `S${"A".repeat(55)}`;
    const masked = maskPii(`signing with ${secret}`);
    expect(masked).not.toContain(secret);
    expect(masked).toContain(PII_REDACTION_PLACEHOLDER);
  });

  it("leaves non-PII content untouched", () => {
    expect(maskPii("order shipped successfully")).toBe("order shipped successfully");
  });

  it("preserves UUID identifiers whose hex groups look like numbers", () => {
    const requestId = "c601569c-cb5d-4251-8f90-9f7782375020";
    expect(maskPii(`requestId=${requestId}`)).toBe(`requestId=${requestId}`);
  });

  it("passes through non-string input unchanged", () => {
    // @ts-expect-error — exercising runtime guard against non-string input
    expect(maskPii(undefined)).toBeUndefined();
  });
});

describe("maskPiiDeep", () => {
  it("masks nested string fields but preserves other types", () => {
    const secret = `S${"B".repeat(55)}`;
    const input = {
      userId: "abc123",
      durationMs: 42,
      ok: true,
      shippingAddress: { email: "customer@example.com", zip: "94107" },
      notes: [`stellar key ${secret}`, "no pii here"],
    };

    const masked = maskPiiDeep(input);

    expect(masked.durationMs).toBe(42);
    expect(masked.ok).toBe(true);
    expect(masked.userId).toBe("abc123");
    expect(masked.shippingAddress.email).not.toContain("customer@example.com");
    expect(masked.notes[0]).not.toContain(secret);
    expect(masked.notes[1]).toBe("no pii here");
  });
});

describe("containsPii", () => {
  it("detects PII across repeated calls (regex state does not leak)", () => {
    expect(containsPii("email me at a@b.com")).toBe(true);
    expect(containsPii("email me at a@b.com")).toBe(true);
    expect(containsPii("totally clean string")).toBe(false);
  });
});
