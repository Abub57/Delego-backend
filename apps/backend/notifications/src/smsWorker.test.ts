import { describe, expect, it, vi } from "vitest";

import {
  SMS_RATE_LIMIT,
  enqueueSmsNotification,
  handleTwilioStatusCallback,
  maskPhoneNumber,
  sendSmsNotification,
  type SmsNotificationJobData,
} from "./smsWorker.js";
import type { SmsSender } from "./sms/types.js";

const job: SmsNotificationJobData = {
  orderId: "order-1",
  recipientPhone: "+2348012345678",
  messageText: "Your order is out for delivery",
  priority: "standard",
};

describe("sendSmsNotification", () => {
  it("sends through the injected sender and returns the provider id", async () => {
    const sender: SmsSender = {
      send: vi.fn(async () => ({ providerMessageId: "SM123" })),
    };

    await expect(sendSmsNotification(job, sender)).resolves.toEqual({
      providerMessageId: "SM123",
    });
    expect(sender.send).toHaveBeenCalledWith({
      channel: "sms",
      to: "+2348012345678",
      body: "Your order is out for delivery",
    });
  });

  it("rejects an invalid E.164 number before calling Twilio", async () => {
    const sender: SmsSender = { send: vi.fn() };
    await expect(
      sendSmsNotification({ ...job, recipientPhone: "08012345678" }, sender)
    ).rejects.toThrow(/E\.164/);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("rejects a job without an order id", async () => {
    const sender: SmsSender = { send: vi.fn() };
    await expect(
      sendSmsNotification({ ...job, orderId: " " }, sender)
    ).rejects.toThrow(/orderId/);
  });

  it("rejects an invalid priority", async () => {
    const sender: SmsSender = { send: vi.fn() };
    await expect(
      sendSmsNotification(
        { ...job, priority: "urgent" as SmsNotificationJobData["priority"] },
        sender
      )
    ).rejects.toThrow(/priority/);
  });
});

describe("enqueueSmsNotification", () => {
  it("validates before touching Redis", async () => {
    await expect(
      enqueueSmsNotification({ ...job, recipientPhone: "not-a-phone" })
    ).rejects.toThrow(/E\.164/);
  });
});

describe("maskPhoneNumber", () => {
  it("keeps a short prefix and the last four digits", () => {
    expect(maskPhoneNumber("+2348012345678")).toBe("+23****5678");
    expect(maskPhoneNumber("1234")).toBe("****");
  });
});

describe("handleTwilioStatusCallback", () => {
  it("reports delivered messages", () => {
    expect(
      handleTwilioStatusCallback({
        MessageSid: "SM1",
        MessageStatus: "delivered",
        To: "+2348012345678",
      })
    ).toEqual({ delivered: true });
  });

  it("reports undelivered and failed messages", () => {
    for (const status of ["undelivered", "failed"] as const) {
      expect(
        handleTwilioStatusCallback({
          MessageSid: "SM1",
          MessageStatus: status,
          To: "+2348012345678",
          ErrorCode: "30003",
        })
      ).toEqual({ delivered: false });
    }
  });
});

describe("SMS_RATE_LIMIT", () => {
  it("caps sends at 10 per second", () => {
    expect(SMS_RATE_LIMIT).toEqual({ max: 10, duration: 1_000 });
  });
});
