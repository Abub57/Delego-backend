// Issue #300 — Localised SMS / WhatsApp message text.
//
// Message text lives in the shared locale files (src/i18n/{en,es,fr}.json)
// under `sms_<messageType>_body`, rendered by the same renderer the email
// notifications use, so a missing translation falls back to English.

import { renderLocalizedTemplate } from "../i18n/localized-template.js";
import type { SmsMessageType, SmsNotificationPayload } from "./types.js";

export interface RenderedSmsMessage {
  body: string;
  /** Locale actually used after fallback. */
  locale: string;
}

export function renderSmsMessage(
  messageType: SmsMessageType,
  locale: string | undefined,
  payload: Pick<SmsNotificationPayload, "orderId" | "trackingNumber">
): RenderedSmsMessage {
  // Translations are keyed by language ("fr"), so "fr-CA" uses French.
  const language = (locale ?? "en").split(/[-_]/)[0];
  const rendered = renderLocalizedTemplate(`sms.${messageType}`, language, {
    orderId: payload.orderId,
    trackingNumber: payload.trackingNumber,
  });
  return { body: rendered.body, locale: rendered.locale };
}
