// Notification preference center (#115)
// Granular per-channel / per-category controls, frequency options, quiet hours
// with timezone support, org -> user inheritance, and a migration tool.
//
// This module is the pure logic layer: types, defaults, validation, and the
// decision functions used both by the management API (index.ts) and by any
// dispatch path. Persistence lives in preferenceCenterStore.ts and the schema
// migration tool in preferenceMigration.ts.

import { DateTime } from "luxon";

export type NotificationChannel = "email" | "push" | "in_app" | "sms" | "whatsapp";

export type ChannelFrequency =
  | "immediate"
  | "hourly_digest"
  | "daily_digest"
  | "weekly_digest";

export type CategoryFrequency = "immediate" | "digest";

export interface ChannelPreference {
  enabled: boolean;
  frequency: ChannelFrequency;
  /** Per notification type override, keyed by event type (e.g. "escrow.released"). */
  types: Record<string, boolean>;
}

export interface CategoryPreference {
  enabled: boolean;
  channels: NotificationChannel[];
  frequency: CategoryFrequency;
  criticalOnly: boolean;
}

export interface QuietHours {
  enabled: boolean;
  /** "HH:mm" in 24h format. */
  start: string;
  /** "HH:mm" in 24h format. */
  end: string;
  /** IANA timezone (e.g. "America/New_York"). */
  timezone: string;
}

export interface NotificationPreference {
  userId: string;
  /** Org this user inherits defaults from (optional). */
  orgId?: string;
  channels: Record<NotificationChannel, ChannelPreference>;
  categories: Record<string, CategoryPreference>;
  quietHours: QuietHours;
  globalUnsubscribe: boolean;
  /** ISO-8601 timestamp of the last update. */
  updatedAt: string;
}

/** Partial update accepted by the management API. */
export interface PreferenceUpdate {
  channels?: Partial<Record<NotificationChannel, Partial<ChannelPreference>>>;
  categories?: Record<string, Partial<CategoryPreference>>;
  quietHours?: Partial<QuietHours>;
  globalUnsubscribe?: boolean;
  orgId?: string;
}

export interface PreferenceMigration {
  fromVersion: number;
  toVersion: number;
  migrations: Array<{
    userId: string;
    changes: Record<string, unknown>;
    status: "pending" | "completed" | "failed";
  }>;
}

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  "email",
  "push",
  "in_app",
  "sms",
  "whatsapp",
];

/** Built-in categories shared with in_app_notifications.category. */
export const NOTIFICATION_CATEGORIES: readonly string[] = [
  "transaction",
  "system",
  "marketing",
  "security",
];

export const DEFAULT_CHANNEL_FREQUENCY: ChannelFrequency = "immediate";
export const DEFAULT_CATEGORY_FREQUENCY: CategoryFrequency = "immediate";
export const DEFAULT_TIMEZONE = "UTC";

export const DEFAULT_CHANNEL_PREFERENCE: ChannelPreference = {
  enabled: true,
  frequency: DEFAULT_CHANNEL_FREQUENCY,
  types: {},
};

export const DEFAULT_CATEGORY_PREFERENCE: CategoryPreference = {
  enabled: true,
  channels: ["email", "push", "in_app", "sms", "whatsapp"],
  frequency: DEFAULT_CATEGORY_FREQUENCY,
  criticalOnly: false,
};

export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  start: "22:00",
  end: "08:00",
  timezone: DEFAULT_TIMEZONE,
};

export function getDefaultChannelPreference(): ChannelPreference {
  return JSON.parse(JSON.stringify(DEFAULT_CHANNEL_PREFERENCE)) as ChannelPreference;
}

export function getDefaultCategoryPreference(): CategoryPreference {
  return JSON.parse(JSON.stringify(DEFAULT_CATEGORY_PREFERENCE)) as CategoryPreference;
}

export function getDefaultNotificationPreference(
  userId: string,
  orgId?: string
): NotificationPreference {
  const channels = {} as Record<NotificationChannel, ChannelPreference>;
  for (const channel of NOTIFICATION_CHANNELS) {
    channels[channel] = getDefaultChannelPreference();
  }
  const categories: Record<string, CategoryPreference> = {};
  for (const category of NOTIFICATION_CATEGORIES) {
    categories[category] = getDefaultCategoryPreference();
  }
  return {
    userId,
    ...(orgId ? { orgId } : {}),
    channels,
    categories,
    quietHours: JSON.parse(JSON.stringify(DEFAULT_QUIET_HOURS)) as QuietHours,
    globalUnsubscribe: false,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Bring a stored preference document saved before the `whatsapp` channel
 * existed (#300) up to date. Such a document has no `channels.whatsapp` entry
 * and its category channel lists never mention whatsapp, which would otherwise
 * block WhatsApp for every user who ever saved preferences. For those legacy
 * documents WhatsApp follows the user's SMS choices: the channel entry copies
 * `channels.sms`, and whatsapp joins every category list that includes sms.
 * Documents that already have a `whatsapp` entry are returned unchanged.
 */
export function upgradeLegacyWhatsappPreference(
  prefs: NotificationPreference
): NotificationPreference {
  // Stored JSON may predate a channel, so don't trust the full Record type here.
  const storedChannels = prefs.channels as
    | Partial<Record<NotificationChannel, ChannelPreference>>
    | undefined;
  if (storedChannels?.whatsapp) return prefs;

  const smsChannel = storedChannels?.sms ?? getDefaultChannelPreference();
  const categories: Record<string, CategoryPreference> = {};
  for (const [key, category] of Object.entries(prefs.categories ?? {})) {
    categories[key] =
      category.channels.includes("sms") && !category.channels.includes("whatsapp")
        ? { ...category, channels: [...category.channels, "whatsapp"] }
        : category;
  }

  return {
    ...prefs,
    channels: {
      ...storedChannels,
      whatsapp: JSON.parse(JSON.stringify(smsChannel)) as ChannelPreference,
    } as Record<NotificationChannel, ChannelPreference>,
    categories,
  };
}

export function isValidTimeZone(timezone: string): boolean {
  return DateTime.local().setZone(timezone).isValid;
}

const HH_MM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidHhMm(value: string): boolean {
  return HH_MM_PATTERN.test(value);
}

export function isValidQuietHours(quietHours: QuietHours): boolean {
  if (!isValidHhMm(quietHours.start) || !isValidHhMm(quietHours.end)) {
    return false;
  }
  if (!isValidTimeZone(quietHours.timezone)) {
    return false;
  }
  return true;
}

export function isInQuietHours(
  quietHours: QuietHours,
  now: Date = new Date()
): boolean {
  if (!quietHours.enabled) return false;
  if (!isValidHhMm(quietHours.start) || !isValidHhMm(quietHours.end)) return false;
  const timezone = isValidTimeZone(quietHours.timezone)
    ? quietHours.timezone
    : DEFAULT_TIMEZONE;
  const zoned = DateTime.fromJSDate(now).setZone(timezone);
  const current = zoned.hour * 60 + zoned.minute;
  const start = parseHhMm(quietHours.start);
  const end = parseHhMm(quietHours.end);
  if (start === end) return false;
  if (start < end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}

function parseHhMm(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function mergeChannelPreference(
  org: ChannelPreference | undefined,
  user: ChannelPreference
): ChannelPreference {
  return {
    enabled:
      user.enabled !== DEFAULT_CHANNEL_PREFERENCE.enabled
        ? user.enabled
        : (org?.enabled ?? DEFAULT_CHANNEL_PREFERENCE.enabled),
    frequency:
      user.frequency !== DEFAULT_CHANNEL_PREFERENCE.frequency
        ? user.frequency
        : (org?.frequency ?? DEFAULT_CHANNEL_PREFERENCE.frequency),
    types: { ...(org?.types ?? {}), ...user.types },
  };
}

function sameChannelList(
  a: NotificationChannel[],
  b: NotificationChannel[]
): boolean {
  if (a.length !== b.length) return false;
  return a.every((channel, i) => channel === b[i]);
}

function mergeCategoryPreference(
  org: CategoryPreference | undefined,
  user: CategoryPreference
): CategoryPreference {
  return {
    enabled:
      user.enabled !== DEFAULT_CATEGORY_PREFERENCE.enabled
        ? user.enabled
        : (org?.enabled ?? DEFAULT_CATEGORY_PREFERENCE.enabled),
    channels: sameChannelList(user.channels, DEFAULT_CATEGORY_PREFERENCE.channels)
      ? (org?.channels ?? DEFAULT_CATEGORY_PREFERENCE.channels)
      : user.channels,
    frequency:
      user.frequency !== DEFAULT_CATEGORY_PREFERENCE.frequency
        ? user.frequency
        : (org?.frequency ?? DEFAULT_CATEGORY_PREFERENCE.frequency),
    criticalOnly:
      user.criticalOnly !== DEFAULT_CATEGORY_PREFERENCE.criticalOnly
        ? user.criticalOnly
        : (org?.criticalOnly ?? DEFAULT_CATEGORY_PREFERENCE.criticalOnly),
  };
}

function mergeQuietHours(
  org: QuietHours | undefined,
  user: QuietHours
): QuietHours {
  if (user.enabled !== DEFAULT_QUIET_HOURS.enabled) return user;
  return org ?? user;
}

/**
 * Resolve the effective preference for a user, applying org -> user
 * inheritance. A user value that still equals the built-in default is treated
 * as unset and falls through to the org default (the org itself falls through
 * to the built-in default). Explicit user choices (values that differ from the
 * built-in default) always win. Per-type channel maps merge key-by-key with
 * user entries winning.
 */
export function resolveEffectivePreference(
  userPrefs: NotificationPreference,
  orgDefaults?: NotificationPreference
): NotificationPreference {
  if (!orgDefaults) return userPrefs;

  const channels = {} as Record<NotificationChannel, ChannelPreference>;
  for (const channel of NOTIFICATION_CHANNELS) {
    channels[channel] = mergeChannelPreference(
      orgDefaults.channels[channel],
      userPrefs.channels[channel] ?? getDefaultChannelPreference()
    );
  }

  const categories: Record<string, CategoryPreference> = {};
  const categoryKeys = new Set([
    ...Object.keys(userPrefs.categories),
    ...Object.keys(orgDefaults.categories),
  ]);
  for (const key of categoryKeys) {
    categories[key] = mergeCategoryPreference(
      orgDefaults.categories[key],
      userPrefs.categories[key] ?? getDefaultCategoryPreference()
    );
  }

  return {
    userId: userPrefs.userId,
    orgId: userPrefs.orgId ?? orgDefaults.orgId,
    channels,
    categories,
    quietHours: mergeQuietHours(orgDefaults.quietHours, userPrefs.quietHours),
    globalUnsubscribe: userPrefs.globalUnsubscribe || orgDefaults.globalUnsubscribe,
    updatedAt: userPrefs.updatedAt,
  };
}

/**
 * Deep-merge a partial update into a preference document. Returns a new
 * document; the input is not mutated. `orgId`, `globalUnsubscribe`, and
 * `quietHours` replace wholesale while `channels` / `categories` merge
 * per-key.
 */
export function applyPreferenceUpdate(
  current: NotificationPreference,
  update: PreferenceUpdate
): NotificationPreference {
  const channels = { ...current.channels };
  for (const channel of NOTIFICATION_CHANNELS) {
    const updateChannel = update.channels?.[channel];
    if (!updateChannel) continue;
    const base = channels[channel] ?? getDefaultChannelPreference();
    channels[channel] = {
      ...base,
      ...updateChannel,
      types: { ...base.types, ...(updateChannel.types ?? {}) },
    };
  }

  const categories = { ...current.categories };
  for (const [key, updateCategory] of Object.entries(update.categories ?? {})) {
    const base = categories[key] ?? getDefaultCategoryPreference();
    categories[key] = { ...base, ...updateCategory };
  }

  return {
    ...current,
    ...(update.orgId !== undefined ? { orgId: update.orgId } : {}),
    channels,
    categories,
    ...(update.quietHours ? { quietHours: { ...current.quietHours, ...update.quietHours } } : {}),
    ...(update.globalUnsubscribe !== undefined
      ? { globalUnsubscribe: update.globalUnsubscribe }
      : {}),
    updatedAt: new Date().toISOString(),
  };
}

export function validatePreferenceUpdate(update: PreferenceUpdate): string[] {
  const errors: string[] = [];
  if (update.channels) {
    for (const [channel, pref] of Object.entries(update.channels)) {
      if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
        errors.push(`Unknown channel "${channel}"`);
        continue;
      }
      if (pref.frequency && !isValidChannelFrequency(pref.frequency)) {
        errors.push(`Invalid frequency "${String(pref.frequency)}" for channel "${channel}"`);
      }
    }
  }
  if (update.categories) {
    for (const [key, pref] of Object.entries(update.categories)) {
      if (pref.channels) {
        for (const channel of pref.channels) {
          if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
            errors.push(`Unknown channel "${channel}" in category "${key}"`);
          }
        }
      }
      if (pref.frequency && pref.frequency !== "immediate" && pref.frequency !== "digest") {
        errors.push(`Invalid category frequency "${String(pref.frequency)}" for category "${key}"`);
      }
    }
  }
  if (update.quietHours) {
    const merged: QuietHours = {
      ...DEFAULT_QUIET_HOURS,
      ...update.quietHours,
    };
    if (update.quietHours.start !== undefined && !isValidHhMm(update.quietHours.start)) {
      errors.push(`Invalid quiet hours start "${update.quietHours.start}" (expected HH:mm)`);
    }
    if (update.quietHours.end !== undefined && !isValidHhMm(update.quietHours.end)) {
      errors.push(`Invalid quiet hours end "${update.quietHours.end}" (expected HH:mm)`);
    }
    if (merged.enabled && !isValidTimeZone(merged.timezone)) {
      errors.push(`Invalid quiet hours timezone "${merged.timezone}"`);
    }
  }
  return errors;
}

function isValidChannelFrequency(value: unknown): value is ChannelFrequency {
  return (
    value === "immediate" ||
    value === "hourly_digest" ||
    value === "daily_digest" ||
    value === "weekly_digest"
  );
}

export interface SendDecisionOptions {
  /** Notification type (event type) to apply per-type channel overrides. */
  type?: string;
  /** Critical notifications bypass quiet hours and criticalOnly filtering. */
  isCritical?: boolean;
  now?: Date;
}

/**
 * Decide whether a notification of `category` should be delivered on `channel`.
 * Enforces global unsubscribe, per-channel enablement, per-type overrides,
 * category enablement / channel membership / criticalOnly, and quiet hours
 * (respecting the configured timezone).
 */
export function shouldSendOnChannel(
  prefs: NotificationPreference,
  channel: NotificationChannel,
  category: string,
  options: SendDecisionOptions = {}
): boolean {
  if (prefs.globalUnsubscribe) return false;

  const channelPref = prefs.channels[channel];
  if (channelPref && !channelPref.enabled) return false;
  if (channelPref && options.type && channelPref.types[options.type] === false) {
    return false;
  }

  const categoryPref = prefs.categories[category];
  if (categoryPref && !categoryPref.enabled) return false;
  if (categoryPref && !categoryPref.channels.includes(channel)) return false;
  if (categoryPref && categoryPref.criticalOnly && !options.isCritical) return false;

  if (!options.isCritical && isInQuietHours(prefs.quietHours, options.now)) {
    return false;
  }

  return true;
}

export type DigestBucket = "none" | "hourly" | "daily" | "weekly";

/**
 * Resolve the digest bucket for a channel/category pair. "none" means the
 * notification should be delivered immediately. Category-level "digest"
 * frequency wins and maps to the daily bucket; channel-level frequencies map
 * to hourly/daily/weekly.
 */
export function getDigestBucket(
  prefs: NotificationPreference,
  channel: NotificationChannel,
  category: string
): DigestBucket {
  const categoryPref = prefs.categories[category];
  if (categoryPref && categoryPref.frequency === "digest") return "daily";

  const channelPref = prefs.channels[channel];
  switch (channelPref?.frequency) {
    case "hourly_digest":
      return "hourly";
    case "daily_digest":
      return "daily";
    case "weekly_digest":
      return "weekly";
    default:
      return "none";
  }
}

export function shouldDeliverImmediately(
  prefs: NotificationPreference,
  channel: NotificationChannel,
  category: string
): boolean {
  return getDigestBucket(prefs, channel, category) === "none";
}
