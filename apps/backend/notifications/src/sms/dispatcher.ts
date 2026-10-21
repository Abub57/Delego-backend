// Issue #300 — SMS & WhatsApp delivery notification dispatcher.
//
// Sends "out for delivery", "auto-release warning" and "refund processed"
// messages through Twilio, after checking the user's notification preferences
// and quiet hours (preference center, #115).

import { createLogger } from "@delegolabs/utils";
import {
  shouldSendOnChannel,
  type NotificationPreference,
} from "../preferenceCenter.js";
import { getEffectivePreference, type PreferenceDb } from "../preferenceCenterStore.js";
import { renderSmsMessage } from "./templates.js";
import type {
  SmsChannel,
  SmsDispatchResult,
  SmsNotificationPayload,
  SmsRecipient,
  SmsSender,
} from "./types.js";

const logger = createLogger("sms-dispatcher");

/** Preference-center category these delivery updates belong to. */
export const SMS_NOTIFICATION_CATEGORY = "transaction";

/** E.164: "+", a non-zero country code digit, up to 15 digits in total. */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export class InvalidPhoneNumberError extends Error {
  constructor(phoneNumber: string) {
    super(`Phone number must be in E.164 format (e.g. +2348012345678), got "${phoneNumber}"`);
    this.name = "InvalidPhoneNumberError";
  }
}

export interface SmsDispatchDeps {
  sender: SmsSender;
  /** Effective preferences for a user (user choices over org defaults). */
  getPreference: (userId: string, orgId?: string) => Promise<NotificationPreference>;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

export interface SmsDispatchOptions {
  /** Defaults to "sms". */
  channel?: SmsChannel;
}

/**
 * Dispatch one delivery notification.
 *
 * Returns `suppressed` (without sending) when the user is in quiet hours or
 * has turned this off: the channel, the "transaction" category, this message
 * type on this channel (`channels.<channel>.types[messageType] = false`), or
 * everything via global unsubscribe. Throws for an invalid phone number or a
 * Twilio failure so the caller's retry handling can take over.
 */
export async function dispatchSmsNotification(
  payload: SmsNotificationPayload,
  recipient: SmsRecipient,
  deps: SmsDispatchDeps,
  options: SmsDispatchOptions = {}
): Promise<SmsDispatchResult> {
  const channel = options.channel ?? "sms";
  if (!E164_PATTERN.test(payload.toPhoneNumber)) {
    throw new InvalidPhoneNumberError(payload.toPhoneNumber);
  }

  const now = deps.now?.() ?? new Date();
  const prefs = await deps.getPreference(recipient.userId, recipient.orgId);
  const decision = { type: payload.messageType, now };

  // Check everything except quiet hours first, so the result says *why* a
  // message was held: quiet hours only delay it, preferences refuse it.
  const allowedOutsideQuietHours = shouldSendOnChannel(
    { ...prefs, quietHours: { ...prefs.quietHours, enabled: false } },
    channel,
    SMS_NOTIFICATION_CATEGORY,
    decision
  );
  if (!allowedOutsideQuietHours) {
    logger.info("SMS suppressed by notification preferences", {
      userId: recipient.userId,
      orderId: payload.orderId,
      channel,
      messageType: payload.messageType,
    });
    return { status: "suppressed", channel, reason: "preferences" };
  }

  if (!shouldSendOnChannel(prefs, channel, SMS_NOTIFICATION_CATEGORY, decision)) {
    logger.info("SMS suppressed by quiet hours", {
      userId: recipient.userId,
      orderId: payload.orderId,
      channel,
      messageType: payload.messageType,
    });
    return { status: "suppressed", channel, reason: "quiet_hours" };
  }

  const message = renderSmsMessage(payload.messageType, recipient.locale, payload);
  const { providerMessageId } = await deps.sender.send({
    channel,
    to: payload.toPhoneNumber,
    body: message.body,
  });

  logger.info("SMS notification sent", {
    userId: recipient.userId,
    orderId: payload.orderId,
    channel,
    messageType: payload.messageType,
    providerMessageId,
  });
  return { status: "sent", channel, providerMessageId, locale: message.locale };
}

/** Dependencies wired to the preference-center tables. */
export function createSmsDispatchDeps(db: PreferenceDb, sender: SmsSender): SmsDispatchDeps {
  return {
    sender,
    getPreference: (userId, orgId) => getEffectivePreference(db, userId, orgId),
  };
}
