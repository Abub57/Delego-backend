// Issue #300 — SMS & WhatsApp delivery notifications.

/** Payload for an SMS / WhatsApp delivery notification (shape from #300). */
export interface SmsNotificationPayload {
  toPhoneNumber: string;
  messageType: "out_for_delivery" | "auto_release_warning" | "refund_processed";
  orderId: string;
  trackingNumber: string;
}

export type SmsMessageType = SmsNotificationPayload["messageType"];

/** Transport used for the message. Both go through Twilio. */
export type SmsChannel = "sms" | "whatsapp";

/**
 * Who the message is for. The payload only carries a phone number, so the
 * user is passed alongside it to look up quiet hours, notification
 * preferences and language.
 */
export interface SmsRecipient {
  userId: string;
  orgId?: string;
  /** BCP-47 locale, e.g. "es" or "fr-CA". Falls back to English. */
  locale?: string;
}

export interface SmsSendRequest {
  channel: SmsChannel;
  /** E.164 phone number, e.g. "+2348012345678". */
  to: string;
  body: string;
}

export interface SmsSendResult {
  /** Provider message id (Twilio message SID). */
  providerMessageId: string;
}

/** Sends a rendered message. Implemented by Twilio in production, faked in tests. */
export interface SmsSender {
  send(request: SmsSendRequest): Promise<SmsSendResult>;
}

export type SmsDispatchResult =
  | {
      status: "sent";
      channel: SmsChannel;
      providerMessageId: string;
      locale: string;
    }
  | {
      status: "suppressed";
      channel: SmsChannel;
      /**
       * `quiet_hours`: the user is inside their quiet hours window.
       * `preferences`: the user (or their org) turned this channel, category
       * or message type off, or unsubscribed from everything.
       */
      reason: "quiet_hours" | "preferences";
    };
