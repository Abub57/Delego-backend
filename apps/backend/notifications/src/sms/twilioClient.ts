// Issue #300 — Twilio-backed sender for SMS and WhatsApp messages.

import twilio from "twilio";
import type { SmsSender, SmsSendRequest, SmsSendResult } from "./types.js";

/** The subset of the Twilio client the sender uses (kept small so tests can fake it). */
export interface TwilioMessagesApi {
  messages: {
    create(params: { to: string; from: string; body: string }): Promise<{ sid: string }>;
  };
}

export interface TwilioSenderConfig {
  /** Sender number for SMS, E.164. */
  smsFrom: string;
  /**
   * Sender number for WhatsApp, E.164 (without the `whatsapp:` prefix).
   * When unset, WhatsApp sends are rejected.
   */
  whatsappFrom?: string;
}

/** Twilio addresses WhatsApp numbers as `whatsapp:+15551234567`. */
function toTwilioAddress(channel: SmsSendRequest["channel"], number: string): string {
  return channel === "whatsapp" ? `whatsapp:${number}` : number;
}

export class TwilioSmsSender implements SmsSender {
  constructor(
    private readonly client: TwilioMessagesApi,
    private readonly config: TwilioSenderConfig
  ) {}

  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    const from =
      request.channel === "whatsapp" ? this.config.whatsappFrom : this.config.smsFrom;
    if (!from) {
      throw new Error(`No Twilio sender number configured for channel "${request.channel}"`);
    }

    const message = await this.client.messages.create({
      to: toTwilioAddress(request.channel, request.to),
      from: toTwilioAddress(request.channel, from),
      body: request.body,
    });
    return { providerMessageId: message.sid };
  }
}

/**
 * Build a sender from the environment:
 * TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM, and optionally
 * TWILIO_WHATSAPP_FROM. Returns null when the required variables are missing,
 * so callers can run without SMS instead of crashing at startup.
 */
export function createTwilioSenderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): TwilioSmsSender | null {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const smsFrom = env.TWILIO_SMS_FROM;
  if (!accountSid || !authToken || !smsFrom) return null;

  return new TwilioSmsSender(twilio(accountSid, authToken), {
    smsFrom,
    whatsappFrom: env.TWILIO_WHATSAPP_FROM || undefined,
  });
}
