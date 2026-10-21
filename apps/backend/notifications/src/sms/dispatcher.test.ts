import { describe, expect, it, vi } from "vitest";
import {
  getDefaultNotificationPreference,
  type NotificationPreference,
} from "../preferenceCenter.js";
import {
  dispatchSmsNotification,
  InvalidPhoneNumberError,
  type SmsDispatchDeps,
} from "./dispatcher.js";
import { renderSmsMessage } from "./templates.js";
import { createTwilioSenderFromEnv, TwilioSmsSender } from "./twilioClient.js";
import type { SmsNotificationPayload, SmsSender } from "./types.js";

const payload: SmsNotificationPayload = {
  toPhoneNumber: "+2348012345678",
  messageType: "out_for_delivery",
  orderId: "ord_123",
  trackingNumber: "TRK-9",
};

function makeSender(): SmsSender & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue({ providerMessageId: "SM123" }) };
}

function makeDeps(
  prefs: NotificationPreference,
  sender: SmsSender,
  now = new Date("2026-09-28T12:00:00Z")
): SmsDispatchDeps {
  return { sender, getPreference: vi.fn().mockResolvedValue(prefs), now: () => now };
}

function prefsWith(mutate: (p: NotificationPreference) => void): NotificationPreference {
  const prefs = getDefaultNotificationPreference("user-1");
  mutate(prefs);
  return prefs;
}

describe("dispatchSmsNotification", () => {
  it("sends an English SMS through the sender with default preferences", async () => {
    const sender = makeSender();
    const result = await dispatchSmsNotification(
      payload,
      { userId: "user-1" },
      makeDeps(getDefaultNotificationPreference("user-1"), sender)
    );

    expect(result).toEqual({
      status: "sent",
      channel: "sms",
      providerMessageId: "SM123",
      locale: "en",
    });
    expect(sender.send).toHaveBeenCalledTimes(1);
    const request = sender.send.mock.calls[0][0];
    expect(request.channel).toBe("sms");
    expect(request.to).toBe("+2348012345678");
    expect(request.body).toContain("ord_123");
    expect(request.body).toContain("TRK-9");
    expect(request.body).toContain("out for delivery");
  });

  it("looks up preferences for the recipient's user and org", async () => {
    const sender = makeSender();
    const deps = makeDeps(getDefaultNotificationPreference("user-1"), sender);
    await dispatchSmsNotification(payload, { userId: "user-1", orgId: "org-7" }, deps);
    expect(deps.getPreference).toHaveBeenCalledWith("user-1", "org-7");
  });

  it("renders in the recipient's language", async () => {
    const sender = makeSender();
    const result = await dispatchSmsNotification(
      payload,
      { userId: "user-1", locale: "es" },
      makeDeps(getDefaultNotificationPreference("user-1"), sender)
    );
    expect(result).toMatchObject({ status: "sent", locale: "es" });
    expect(sender.send.mock.calls[0][0].body).toContain("Seguimiento: TRK-9");
  });

  describe("quiet hours", () => {
    // 22:00–07:00 in Lagos (UTC+1), a window that wraps past midnight.
    const quiet = prefsWith((p) => {
      p.quietHours = { enabled: true, start: "22:00", end: "07:00", timezone: "Africa/Lagos" };
    });

    it("suppresses the message inside the window without calling Twilio", async () => {
      const sender = makeSender();
      const lateNight = new Date("2026-09-28T22:30:00Z"); // 23:30 in Lagos
      const result = await dispatchSmsNotification(
        payload,
        { userId: "user-1" },
        makeDeps(quiet, sender, lateNight)
      );
      expect(result).toEqual({ status: "suppressed", channel: "sms", reason: "quiet_hours" });
      expect(sender.send).not.toHaveBeenCalled();
    });

    it("sends outside the window", async () => {
      const sender = makeSender();
      const midday = new Date("2026-09-28T11:00:00Z"); // 12:00 in Lagos
      const result = await dispatchSmsNotification(
        payload,
        { userId: "user-1" },
        makeDeps(quiet, sender, midday)
      );
      expect(result.status).toBe("sent");
    });

    it("also applies to WhatsApp", async () => {
      const sender = makeSender();
      const result = await dispatchSmsNotification(
        payload,
        { userId: "user-1" },
        makeDeps(quiet, sender, new Date("2026-09-28T05:00:00Z")), // 06:00 in Lagos
        { channel: "whatsapp" }
      );
      expect(result).toEqual({ status: "suppressed", channel: "whatsapp", reason: "quiet_hours" });
    });
  });

  describe("notification preferences", () => {
    it.each<[string, (p: NotificationPreference) => void]>([
      ["sms channel disabled", (p) => (p.channels.sms.enabled = false)],
      ["this message type disabled on sms", (p) => (p.channels.sms.types.out_for_delivery = false)],
      ["transaction category disabled", (p) => (p.categories.transaction.enabled = false)],
      [
        "sms removed from the transaction category",
        (p) => (p.categories.transaction.channels = ["email", "push"]),
      ],
      ["global unsubscribe", (p) => (p.globalUnsubscribe = true)],
    ])("suppresses when %s", async (_label, mutate) => {
      const sender = makeSender();
      const result = await dispatchSmsNotification(
        payload,
        { userId: "user-1" },
        makeDeps(prefsWith(mutate), sender)
      );
      expect(result).toEqual({ status: "suppressed", channel: "sms", reason: "preferences" });
      expect(sender.send).not.toHaveBeenCalled();
    });

    it("reports preferences, not quiet hours, when both apply", async () => {
      const sender = makeSender();
      const prefs = prefsWith((p) => {
        p.channels.sms.enabled = false;
        p.quietHours = { enabled: true, start: "00:00", end: "23:59", timezone: "UTC" };
      });
      const result = await dispatchSmsNotification(payload, { userId: "user-1" }, makeDeps(prefs, sender));
      expect(result).toMatchObject({ status: "suppressed", reason: "preferences" });
    });

    it("keeps other message types when one type is disabled", async () => {
      const sender = makeSender();
      const prefs = prefsWith((p) => (p.channels.sms.types.out_for_delivery = false));
      const result = await dispatchSmsNotification(
        { ...payload, messageType: "refund_processed" },
        { userId: "user-1" },
        makeDeps(prefs, sender)
      );
      expect(result.status).toBe("sent");
    });

    it("lets WhatsApp be turned off separately from SMS", async () => {
      const prefs = prefsWith((p) => (p.channels.whatsapp.enabled = false));
      const whatsappSender = makeSender();
      const smsSender = makeSender();

      const whatsapp = await dispatchSmsNotification(
        payload,
        { userId: "user-1" },
        makeDeps(prefs, whatsappSender),
        { channel: "whatsapp" }
      );
      const sms = await dispatchSmsNotification(payload, { userId: "user-1" }, makeDeps(prefs, smsSender));

      expect(whatsapp).toMatchObject({ status: "suppressed", reason: "preferences" });
      expect(whatsappSender.send).not.toHaveBeenCalled();
      expect(sms.status).toBe("sent");
    });
  });

  it("sends over WhatsApp when asked", async () => {
    const sender = makeSender();
    const result = await dispatchSmsNotification(
      payload,
      { userId: "user-1" },
      makeDeps(getDefaultNotificationPreference("user-1"), sender),
      { channel: "whatsapp" }
    );
    expect(result).toMatchObject({ status: "sent", channel: "whatsapp" });
    expect(sender.send.mock.calls[0][0].channel).toBe("whatsapp");
  });

  it("rejects a phone number that is not E.164 before doing anything else", async () => {
    const sender = makeSender();
    const deps = makeDeps(getDefaultNotificationPreference("user-1"), sender);
    await expect(
      dispatchSmsNotification({ ...payload, toPhoneNumber: "08012345678" }, { userId: "user-1" }, deps)
    ).rejects.toBeInstanceOf(InvalidPhoneNumberError);
    expect(deps.getPreference).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("propagates a Twilio failure so the caller can retry", async () => {
    const sender: SmsSender = { send: vi.fn().mockRejectedValue(new Error("Twilio 503")) };
    await expect(
      dispatchSmsNotification(
        payload,
        { userId: "user-1" },
        makeDeps(getDefaultNotificationPreference("user-1"), sender)
      )
    ).rejects.toThrow("Twilio 503");
  });
});

describe("renderSmsMessage", () => {
  const types = ["out_for_delivery", "auto_release_warning", "refund_processed"] as const;

  it.each(["en", "es", "fr"])("has text for every message type in %s", (locale) => {
    for (const type of types) {
      const { body, locale: used } = renderSmsMessage(type, locale, payload);
      expect(used).toBe(locale);
      expect(body).not.toMatch(/^\[sms_/);
      expect(body).toContain("ord_123");
      expect(body).toContain("TRK-9");
    }
  });

  it("uses the language of a regional locale", () => {
    expect(renderSmsMessage("refund_processed", "fr-CA", payload).locale).toBe("fr");
  });

  it("falls back to English for an unsupported language", () => {
    const { body, locale } = renderSmsMessage("refund_processed", "de", payload);
    expect(locale).toBe("en");
    expect(body).toContain("refund for order ord_123");
  });
});

describe("TwilioSmsSender", () => {
  function makeClient() {
    return { messages: { create: vi.fn().mockResolvedValue({ sid: "SM999" }) } };
  }

  it("sends SMS from the SMS number", async () => {
    const client = makeClient();
    const sender = new TwilioSmsSender(client, { smsFrom: "+15550001111" });
    const result = await sender.send({ channel: "sms", to: "+2348012345678", body: "hi" });
    expect(result).toEqual({ providerMessageId: "SM999" });
    expect(client.messages.create).toHaveBeenCalledWith({
      to: "+2348012345678",
      from: "+15550001111",
      body: "hi",
    });
  });

  it("prefixes both numbers with whatsapp: for WhatsApp", async () => {
    const client = makeClient();
    const sender = new TwilioSmsSender(client, {
      smsFrom: "+15550001111",
      whatsappFrom: "+15550002222",
    });
    await sender.send({ channel: "whatsapp", to: "+2348012345678", body: "hi" });
    expect(client.messages.create).toHaveBeenCalledWith({
      to: "whatsapp:+2348012345678",
      from: "whatsapp:+15550002222",
      body: "hi",
    });
  });

  it("refuses WhatsApp when no WhatsApp sender number is configured", async () => {
    const client = makeClient();
    const sender = new TwilioSmsSender(client, { smsFrom: "+15550001111" });
    await expect(
      sender.send({ channel: "whatsapp", to: "+2348012345678", body: "hi" })
    ).rejects.toThrow('No Twilio sender number configured for channel "whatsapp"');
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it("is not created when Twilio credentials are missing", () => {
    expect(createTwilioSenderFromEnv({})).toBeNull();
    expect(
      createTwilioSenderFromEnv({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" })
    ).toBeNull();
  });

  it("is created from the environment", () => {
    const sender = createTwilioSenderFromEnv({
      TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
      TWILIO_AUTH_TOKEN: "test-token",
      TWILIO_SMS_FROM: "+15550001111",
    });
    expect(sender).toBeInstanceOf(TwilioSmsSender);
  });
});
