import { describe, it, expect, vi } from "vitest";
import type { LowStockAlertPayload } from "@delegolabs/types";
import {
  buildLowStockEmail,
  lowStockEventId,
  processLowStockJob,
  type LowStockJobDeps,
} from "./worker.js";

const PAYLOAD: LowStockAlertPayload = {
  merchantId: "merchant-1",
  productId: "product-1",
  sku: "TR-42",
  title: "Trail <Runner>",
  currentStock: 2,
  threshold: 5,
  triggeredAt: "2026-10-19T12:00:00.000Z",
};

function deps(overrides: Partial<LowStockJobDeps> = {}): LowStockJobDeps {
  return {
    dispatchWebhook: vi.fn(async () => undefined),
    getMerchantContact: vi.fn(async () => ({ email: "owner@acme.test", storeName: "Acme" })),
    sendEmail: vi.fn(async () => undefined),
    dashboardUrl: "https://merchant.example/",
    ...overrides,
  };
}

describe("processLowStockJob", () => {
  it("dispatches the inventory.low_stock webhook with a stable event id", async () => {
    const d = deps();

    const outcome = await processLowStockJob("dispatch-webhook", PAYLOAD, d);

    expect(outcome).toBe("webhook_dispatched");
    expect(d.dispatchWebhook).toHaveBeenCalledWith("inventory.low_stock", PAYLOAD, lowStockEventId(PAYLOAD));
  });

  it("emails the merchant contact address", async () => {
    const d = deps();

    const outcome = await processLowStockJob("send-email", PAYLOAD, d);

    expect(outcome).toBe("email_sent");
    expect(d.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "owner@acme.test", subject: "Low stock: Trail <Runner> (2 left)" }),
    );
  });

  it("skips the email when the merchant has no contact address", async () => {
    const d = deps({ getMerchantContact: vi.fn(async () => ({ email: null, storeName: null })) });

    expect(await processLowStockJob("send-email", PAYLOAD, d)).toBe("email_skipped_no_contact");
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it("rethrows transient email failures so BullMQ retries", async () => {
    const transient = new Error("503 Service Unavailable");
    const d = deps({ sendEmail: vi.fn(async () => Promise.reject(transient)) });

    await expect(processLowStockJob("send-email", PAYLOAD, d)).rejects.toBe(transient);
  });

  it("rejects unknown job names", async () => {
    await expect(processLowStockJob("nope", PAYLOAD, deps())).rejects.toThrow(/Unknown low-stock job/);
  });
});

describe("buildLowStockEmail", () => {
  it("escapes product data in the HTML body", () => {
    const email = buildLowStockEmail("owner@acme.test", PAYLOAD, "https://merchant.example/", "Acme & Co");

    expect(email.html).toContain("Trail &lt;Runner&gt;");
    expect(email.html).toContain("Hi Acme &amp; Co,");
    expect(email.html).toContain("https://merchant.example/inventory/product-1");
    expect(email.html).not.toContain("<Runner>");
  });
});
