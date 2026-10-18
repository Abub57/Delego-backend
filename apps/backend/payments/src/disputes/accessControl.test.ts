import { describe, it, expect } from "vitest";
import {
  checkOrderAccess,
  extractRequesterAddress,
  extractRequesterRole,
  isPartyToOrder,
} from "./accessControl.js";

// Issue #350 — IDOR mitigation on dispute/order access.

const record = { buyerAddress: "GBUYER", sellerAddress: "GSELLER" };

describe("isPartyToOrder", () => {
  it("allows the buyer", () => {
    expect(isPartyToOrder(record, "GBUYER")).toBe(true);
  });

  it("allows the seller", () => {
    expect(isPartyToOrder(record, "GSELLER")).toBe(true);
  });

  it("denies an unrelated address", () => {
    expect(isPartyToOrder(record, "GATTACKER")).toBe(false);
  });

  it("allows an admin regardless of address", () => {
    expect(isPartyToOrder(record, "GADMIN", "admin")).toBe(true);
  });

  it("denies when there is no payment record to check against", () => {
    expect(isPartyToOrder(null, "GBUYER")).toBe(false);
  });
});

describe("checkOrderAccess", () => {
  it("allows a party to the order", () => {
    expect(checkOrderAccess(record, "GSELLER").ok).toBe(true);
  });

  it("denies a non-party and reports why", () => {
    const result = checkOrderAccess(record, "GATTACKER");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("NOT_A_PARTY");
  });

  it("fails closed when the payment record can't be resolved", () => {
    const result = checkOrderAccess(null, "GBUYER");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("RECORD_NOT_FOUND");
  });
});

describe("header extraction", () => {
  it("extracts the requester address", () => {
    expect(extractRequesterAddress({ "x-requester-address": "GBUYER" })).toBe("GBUYER");
    expect(extractRequesterAddress({})).toBeUndefined();
  });

  it("extracts a recognized requester role", () => {
    expect(extractRequesterRole({ "x-requester-role": "merchant" })).toBe("merchant");
    expect(extractRequesterRole({ "x-requester-role": "bogus" })).toBeUndefined();
    expect(extractRequesterRole({})).toBeUndefined();
  });
});
