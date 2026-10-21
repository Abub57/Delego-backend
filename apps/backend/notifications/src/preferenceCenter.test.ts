import { describe, it, expect } from "vitest";
import {
  upgradeLegacyWhatsappPreference,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_CATEGORIES,
  getDefaultNotificationPreference,
  getDefaultChannelPreference,
  getDefaultCategoryPreference,
  isValidTimeZone,
  isValidHhMm,
  isValidQuietHours,
  isInQuietHours,
  applyPreferenceUpdate,
  resolveEffectivePreference,
  shouldSendOnChannel,
  getDigestBucket,
  shouldDeliverImmediately,
  validatePreferenceUpdate,
  type NotificationPreference,
} from "./preferenceCenter.js";

function defaultPrefs(userId = "user-1", orgId?: string): NotificationPreference {
  return getDefaultNotificationPreference(userId, orgId);
}

describe("getDefaultNotificationPreference", () => {
  it("includes all four channels", () => {
    const prefs = defaultPrefs();
    for (const channel of NOTIFICATION_CHANNELS) {
      expect(prefs.channels[channel]).toBeDefined();
      expect(prefs.channels[channel].enabled).toBe(true);
    }
  });

  it("includes all built-in categories", () => {
    const prefs = defaultPrefs();
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(prefs.categories[category]).toBeDefined();
    }
  });

  it("disables quiet hours and global unsubscribe by default", () => {
    const prefs = defaultPrefs();
    expect(prefs.quietHours.enabled).toBe(false);
    expect(prefs.globalUnsubscribe).toBe(false);
  });

  it("deep-copies defaults so mutations do not leak", () => {
    const a = defaultPrefs();
    const b = defaultPrefs();
    a.channels.email.enabled = false;
    a.categories.security.enabled = false;
    expect(b.channels.email.enabled).toBe(true);
    expect(b.categories.security.enabled).toBe(true);
  });
});

describe("timezone and quiet hours", () => {
  it("validates IANA timezones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });

  it("validates HH:mm format", () => {
    expect(isValidHhMm("22:00")).toBe(true);
    expect(isValidHhMm("00:00")).toBe(true);
    expect(isValidHhMm("25:00")).toBe(false);
    expect(isValidHhMm("9:00")).toBe(false);
    expect(isValidHhMm("22:60")).toBe(false);
  });

  it("isInQuietHours returns false when disabled", () => {
    const prefs = defaultPrefs();
    expect(isInQuietHours(prefs.quietHours, new Date("2026-01-01T23:00:00Z"))).toBe(false);
  });

  it("respects a same-day window", () => {
    const quietHours = {
      enabled: true,
      start: "22:00",
      end: "08:00",
      timezone: "UTC",
    };
    expect(isInQuietHours(quietHours, new Date("2026-01-01T23:00:00Z"))).toBe(true);
    expect(isInQuietHours(quietHours, new Date("2026-01-01T05:00:00Z"))).toBe(true);
    expect(isInQuietHours(quietHours, new Date("2026-01-01T12:00:00Z"))).toBe(false);
  });

  it("respects a non-overnight window", () => {
    const quietHours = {
      enabled: true,
      start: "09:00",
      end: "17:00",
      timezone: "UTC",
    };
    expect(isInQuietHours(quietHours, new Date("2026-01-01T10:00:00Z"))).toBe(true);
    expect(isInQuietHours(quietHours, new Date("2026-01-01T18:00:00Z"))).toBe(false);
  });

  it("respects the configured timezone", () => {
    const quietHours = {
      enabled: true,
      start: "22:00",
      end: "08:00",
      timezone: "America/New_York",
    };
    // 02:00 UTC is 21:00 in New York (EST) -> outside quiet hours.
    expect(isInQuietHours(quietHours, new Date("2026-01-01T02:00:00Z"))).toBe(false);
    // 04:00 UTC is 23:00 in New York (EST) -> inside quiet hours.
    expect(isInQuietHours(quietHours, new Date("2026-01-01T04:00:00Z"))).toBe(true);
  });

  it("validates a full quiet hours object", () => {
    expect(
      isValidQuietHours({ enabled: true, start: "22:00", end: "08:00", timezone: "UTC" })
    ).toBe(true);
    expect(
      isValidQuietHours({ enabled: true, start: "22:00", end: "08:00", timezone: "Bogus" })
    ).toBe(false);
    expect(
      isValidQuietHours({ enabled: true, start: "9pm", end: "08:00", timezone: "UTC" })
    ).toBe(false);
  });
});

describe("applyPreferenceUpdate", () => {
  it("deep-merges a partial channel update", () => {
    const prefs = defaultPrefs();
    const updated = applyPreferenceUpdate(prefs, {
      channels: { email: { enabled: false, frequency: "daily_digest" } },
    });
    expect(updated.channels.email.enabled).toBe(false);
    expect(updated.channels.email.frequency).toBe("daily_digest");
    expect(updated.channels.push.enabled).toBe(true);
  });

  it("merges per-type overrides onto the existing map", () => {
    const prefs = defaultPrefs();
    const first = applyPreferenceUpdate(prefs, {
      channels: { push: { types: { "escrow.released": false } } },
    });
    const second = applyPreferenceUpdate(first, {
      channels: { push: { types: { "payment.failed": true } } },
    });
    expect(second.channels.push.types["escrow.released"]).toBe(false);
    expect(second.channels.push.types["payment.failed"]).toBe(true);
  });

  it("updates a category while preserving others", () => {
    const prefs = defaultPrefs();
    const updated = applyPreferenceUpdate(prefs, {
      categories: {
        marketing: { enabled: false, channels: ["email"], criticalOnly: true },
      },
    });
    expect(updated.categories.marketing.enabled).toBe(false);
    expect(updated.categories.marketing.channels).toEqual(["email"]);
    expect(updated.categories.transaction.enabled).toBe(true);
  });

  it("merges quiet hours and toggles global unsubscribe", () => {
    const prefs = defaultPrefs();
    const updated = applyPreferenceUpdate(prefs, {
      quietHours: { enabled: true, start: "20:00", end: "07:00", timezone: "Europe/London" },
      globalUnsubscribe: true,
    });
    expect(updated.quietHours.enabled).toBe(true);
    expect(updated.quietHours.timezone).toBe("Europe/London");
    expect(updated.globalUnsubscribe).toBe(true);
  });

  it("does not mutate the input", () => {
    const prefs = defaultPrefs();
    applyPreferenceUpdate(prefs, { channels: { email: { enabled: false } } });
    expect(prefs.channels.email.enabled).toBe(true);
  });
});

describe("resolveEffectivePreference (org -> user inheritance)", () => {
  it("returns the user document unchanged when no org defaults exist", () => {
    const prefs = defaultPrefs();
    expect(resolveEffectivePreference(prefs)).toBe(prefs);
  });

  it("inherits org defaults when the user value equals the built-in default", () => {
    const user = defaultPrefs("user-1", "org-1");
    const org = defaultPrefs("org-1", "org-1");
    org.channels.sms.enabled = false;
    org.categories.marketing.frequency = "digest";
    org.quietHours = { enabled: true, start: "22:00", end: "08:00", timezone: "UTC" };

    const effective = resolveEffectivePreference(user, org);
    expect(effective.orgId).toBe("org-1");
    expect(effective.channels.sms.enabled).toBe(false);
    expect(effective.categories.marketing.frequency).toBe("digest");
    expect(effective.quietHours.enabled).toBe(true);
  });

  it("lets explicit user choices (non-default values) override org defaults", () => {
    const org = defaultPrefs("org-1", "org-1");
    org.channels.email.frequency = "daily_digest";

    const user = defaultPrefs("user-1", "org-1");
    const withOverride = applyPreferenceUpdate(user, {
      channels: { email: { frequency: "weekly_digest" } },
    });

    const effective = resolveEffectivePreference(withOverride, org);
    expect(effective.channels.email.frequency).toBe("weekly_digest");
  });

  it("treats a user value equal to the built-in default as unset (inherits org)", () => {
    // Re-enabling sms to the default `true` when the org disabled it still
    // falls through to the org default, because the user value equals the
    // built-in default. Explicit non-default choices always win instead.
    const org = defaultPrefs("org-1", "org-1");
    org.channels.sms.enabled = false;

    const user = defaultPrefs("user-1", "org-1");
    const withOverride = applyPreferenceUpdate(user, {
      channels: { sms: { enabled: true } },
    });

    const effective = resolveEffectivePreference(withOverride, org);
    expect(effective.channels.sms.enabled).toBe(false);
  });

  it("combines global unsubscribe with OR semantics", () => {
    const org = defaultPrefs("org-1", "org-1");
    org.globalUnsubscribe = true;
    const user = defaultPrefs("user-1", "org-1");
    const effective = resolveEffectivePreference(user, org);
    expect(effective.globalUnsubscribe).toBe(true);
  });
});

describe("shouldSendOnChannel", () => {
  it("returns false when globally unsubscribed", () => {
    const prefs = defaultPrefs();
    prefs.globalUnsubscribe = true;
    expect(shouldSendOnChannel(prefs, "email", "transaction")).toBe(false);
  });

  it("returns false when the channel is disabled", () => {
    const prefs = applyPreferenceUpdate(defaultPrefs(), {
      channels: { email: { enabled: false } },
    });
    expect(shouldSendOnChannel(prefs, "email", "transaction")).toBe(false);
    expect(shouldSendOnChannel(prefs, "push", "transaction")).toBe(true);
  });

  it("honors per-type overrides", () => {
    const prefs = applyPreferenceUpdate(defaultPrefs(), {
      channels: { push: { types: { "escrow.released": false } } },
    });
    expect(shouldSendOnChannel(prefs, "push", "transaction", { type: "escrow.released" })).toBe(false);
    expect(shouldSendOnChannel(prefs, "push", "transaction", { type: "payment.failed" })).toBe(true);
  });

  it("returns false when the category is disabled", () => {
    const prefs = applyPreferenceUpdate(defaultPrefs(), {
      categories: { marketing: { enabled: false } },
    });
    expect(shouldSendOnChannel(prefs, "email", "marketing")).toBe(false);
    expect(shouldSendOnChannel(prefs, "email", "transaction")).toBe(true);
  });

  it("respects category channel membership", () => {
    const prefs = applyPreferenceUpdate(defaultPrefs(), {
      categories: { marketing: { channels: ["email"] } },
    });
    expect(shouldSendOnChannel(prefs, "email", "marketing")).toBe(true);
    expect(shouldSendOnChannel(prefs, "sms", "marketing")).toBe(false);
  });

  it("applies criticalOnly filtering", () => {
    const prefs = applyPreferenceUpdate(defaultPrefs(), {
      categories: { security: { criticalOnly: true } },
    });
    expect(shouldSendOnChannel(prefs, "email", "security", { isCritical: true })).toBe(true);
    expect(shouldSendOnChannel(prefs, "email", "security", { isCritical: false })).toBe(false);
  });

  it("suppresses non-critical notifications during quiet hours", () => {
    const prefs = applyPreferenceUpdate(defaultPrefs(), {
      quietHours: { enabled: true, start: "22:00", end: "08:00", timezone: "UTC" },
    });
    const duringQuietHours = new Date("2026-01-01T23:00:00Z");
    expect(
      shouldSendOnChannel(prefs, "email", "transaction", { now: duringQuietHours })
    ).toBe(false);
    expect(
      shouldSendOnChannel(prefs, "email", "transaction", {
        now: duringQuietHours,
        isCritical: true,
      })
    ).toBe(true);
  });

  it("delivers outside quiet hours", () => {
    const prefs = applyPreferenceUpdate(defaultPrefs(), {
      quietHours: { enabled: true, start: "22:00", end: "08:00", timezone: "UTC" },
    });
    const outsideQuietHours = new Date("2026-01-01T12:00:00Z");
    expect(
      shouldSendOnChannel(prefs, "email", "transaction", { now: outsideQuietHours })
    ).toBe(true);
  });
});

describe("frequency / digest buckets", () => {
  it("defaults to immediate delivery", () => {
    const prefs = defaultPrefs();
    expect(getDigestBucket(prefs, "email", "transaction")).toBe("none");
    expect(shouldDeliverImmediately(prefs, "email", "transaction")).toBe(true);
  });

  it("deferrals a category-level digest", () => {
    const prefs = applyPreferenceUpdate(defaultPrefs(), {
      categories: { marketing: { frequency: "digest" } },
    });
    expect(getDigestBucket(prefs, "email", "marketing")).toBe("daily");
    expect(shouldDeliverImmediately(prefs, "email", "marketing")).toBe(false);
  });

  it("maps channel-level digest frequencies to buckets", () => {
    const prefs = applyPreferenceUpdate(defaultPrefs(), {
      channels: { email: { frequency: "hourly_digest" }, sms: { frequency: "weekly_digest" } },
    });
    expect(getDigestBucket(prefs, "email", "transaction")).toBe("hourly");
    expect(getDigestBucket(prefs, "sms", "transaction")).toBe("weekly");
    expect(getDigestBucket(prefs, "push", "transaction")).toBe("none");
  });
});

describe("validatePreferenceUpdate", () => {
  it("accepts a valid partial update", () => {
    expect(
      validatePreferenceUpdate({
        channels: { email: { enabled: false, frequency: "daily_digest" } },
        categories: { marketing: { enabled: true } },
        quietHours: { enabled: true, start: "22:00", end: "08:00", timezone: "UTC" },
        globalUnsubscribe: false,
      })
    ).toEqual([]);
  });

  it("rejects unknown channels", () => {
    const errors = validatePreferenceUpdate({
      channels: { smoke_signal: { enabled: true } },
    });
    expect(errors.some((e) => e.includes("Unknown channel"))).toBe(true);
  });

  it("rejects invalid channel frequencies", () => {
    const errors = validatePreferenceUpdate({
      channels: { email: { frequency: "yearly" as never } },
    });
    expect(errors.some((e) => e.includes("Invalid frequency"))).toBe(true);
  });

  it("rejects invalid quiet hours format and timezone", () => {
    const errors = validatePreferenceUpdate({
      quietHours: { enabled: true, start: "9pm", timezone: "Bogus/Zone" },
    });
    expect(errors.some((e) => e.includes("Invalid quiet hours start"))).toBe(true);
    expect(errors.some((e) => e.includes("Invalid quiet hours timezone"))).toBe(true);
  });
});

describe("upgradeLegacyWhatsappPreference (#300)", () => {
  function legacy(mutate: (doc: NotificationPreference) => void = () => {}): NotificationPreference {
    const doc = getDefaultNotificationPreference("user-1");
    mutate(doc);
    const raw = doc as unknown as {
      channels: Record<string, unknown>;
      categories: Record<string, { channels: string[] }>;
    };
    delete raw.channels.whatsapp;
    for (const category of Object.values(raw.categories)) {
      category.channels = category.channels.filter((c) => c !== "whatsapp");
    }
    return doc;
  }

  it("copies the SMS channel setting to WhatsApp", () => {
    const upgraded = upgradeLegacyWhatsappPreference(
      legacy((doc) => {
        doc.channels.sms.enabled = false;
        doc.channels.sms.types["out_for_delivery"] = false;
      })
    );
    expect(upgraded.channels.whatsapp.enabled).toBe(false);
    expect(upgraded.channels.whatsapp.types["out_for_delivery"]).toBe(false);
  });

  it("adds whatsapp to categories that allow sms, and only those", () => {
    const upgraded = upgradeLegacyWhatsappPreference(
      legacy((doc) => {
        doc.categories.marketing.channels = ["email"];
      })
    );
    expect(upgraded.categories.transaction.channels).toContain("whatsapp");
    expect(upgraded.categories.marketing.channels).toEqual(["email"]);
  });

  it("does not let a legacy user receive WhatsApp where SMS was blocked", () => {
    const upgraded = upgradeLegacyWhatsappPreference(
      legacy((doc) => {
        doc.categories.transaction.channels = ["email", "push"];
      })
    );
    expect(shouldSendOnChannel(upgraded, "whatsapp", "transaction")).toBe(false);
    expect(shouldSendOnChannel(upgraded, "sms", "transaction")).toBe(false);
  });

  it("allows WhatsApp for a legacy user who allows SMS", () => {
    const upgraded = upgradeLegacyWhatsappPreference(legacy());
    expect(shouldSendOnChannel(upgraded, "whatsapp", "transaction")).toBe(true);
  });

  it("leaves documents that already have a whatsapp entry unchanged", () => {
    const current = getDefaultNotificationPreference("user-1");
    current.channels.whatsapp.enabled = false;
    current.channels.sms.enabled = true;
    expect(upgradeLegacyWhatsappPreference(current)).toBe(current);
  });

  it("does not mutate its input", () => {
    const doc = legacy();
    const before = JSON.stringify(doc);
    upgradeLegacyWhatsappPreference(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
