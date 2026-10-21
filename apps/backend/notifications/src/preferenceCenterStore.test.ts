import { describe, it, expect, vi } from "vitest";
import {
  getStoredPreference,
  upsertStoredPreference,
  getOrgDefaultPreference,
  upsertOrgDefaultPreference,
  getEffectivePreference,
  updateStoredPreference,
  listLegacyPreferences,
  createMigrationRecord,
  listMigrationRecords,
  PREFERENCE_VERSION_CURRENT,
  type PreferenceDb,
} from "./preferenceCenterStore.js";
import {
  getDefaultNotificationPreference,
  applyPreferenceUpdate,
  type NotificationPreference,
} from "./preferenceCenter.js";

function makeDb(rowsByCall: unknown[][]): PreferenceDb {
  const query = vi.fn();
  rowsByCall.forEach((rows, i) => query.mockResolvedValueOnce({ rows }));
  return { query };
}

function makeDbSequence(...responses: unknown[][]): PreferenceDb {
  const query = vi.fn();
  for (const rows of responses) query.mockResolvedValueOnce({ rows });
  return { query };
}

const fullRow = (overrides: Record<string, unknown> = {}) => ({
  user_id: "user-1",
  org_id: null,
  email_enabled: true,
  push_enabled: true,
  preferences: null,
  version: 1,
  updated_at: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

describe("getStoredPreference", () => {
  it("returns null when no row exists", async () => {
    const db = makeDb([[]]);
    expect(await getStoredPreference(db, "user-1")).toBeNull();
  });

  it("parses a stored JSONB document", async () => {
    const doc = getDefaultNotificationPreference("user-1");
    const db = makeDb([[fullRow({ preferences: doc, version: 2 })]]);
    const stored = await getStoredPreference(db, "user-1");
    expect(stored).not.toBeNull();
    expect(stored?.version).toBe(2);
    expect(stored?.preferences.userId).toBe("user-1");
  });

  it("falls back to a default document when preferences is null", async () => {
    const db = makeDb([[fullRow()]]);
    const stored = await getStoredPreference(db, "user-1");
    expect(stored?.preferences.channels.email.enabled).toBe(true);
    expect(stored?.preferences.categories.security).toBeDefined();
  });
});

describe("upsertStoredPreference", () => {
  it("writes the document and legacy toggles", async () => {
    const prefs = getDefaultNotificationPreference("user-1", "org-9");
    const db = makeDb([[fullRow({ org_id: "org-9", preferences: prefs, version: 2 })]]);
    const stored = await upsertStoredPreference(db, "user-1", prefs, "org-9");
    expect(stored.userId).toBe("user-1");
    expect(stored.orgId).toBe("org-9");

    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT \(user_id\)/i);
    expect(params).toContain("user-1");
    expect(params).toContain("org-9");
    expect(params[2]).toBe(true); // email_enabled
    expect(params[3]).toBe(true); // push_enabled
    expect(params[5]).toBe(PREFERENCE_VERSION_CURRENT);
  });
});

describe("org defaults", () => {
  it("returns null when no org defaults exist", async () => {
    const db = makeDb([[]]);
    expect(await getOrgDefaultPreference(db, "org-1")).toBeNull();
  });

  it("returns the stored org document", async () => {
    const doc = getDefaultNotificationPreference("org-1", "org-1");
    const db = makeDb([[{ org_id: "org-1", preferences: doc, version: 2, updated_at: new Date() }]]);
    const prefs = await getOrgDefaultPreference(db, "org-1");
    expect(prefs?.userId).toBe("org-1");
  });

  it("upserts org defaults", async () => {
    const db = makeDbSequence([]);
    const prefs = getDefaultNotificationPreference("org-1", "org-1");
    await upsertOrgDefaultPreference(db, "org-1", prefs);
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/org_notification_preferences/);
    expect(params[0]).toBe("org-1");
  });
});

describe("getEffectivePreference", () => {
  it("returns built-in defaults for an unknown user without org", async () => {
    const db = makeDb([[], []]);
    const prefs = await getEffectivePreference(db, "user-1");
    expect(prefs.userId).toBe("user-1");
    expect(prefs.channels.sms.enabled).toBe(true);
  });

  it("inherits org defaults for a new user", async () => {
    const orgDoc = getDefaultNotificationPreference("org-1", "org-1");
    orgDoc.channels.sms.enabled = false;
    const db = makeDb([
      [], // no stored user doc
      [{ org_id: "org-1", preferences: orgDoc, version: 2, updated_at: new Date() }],
    ]);
    const prefs = await getEffectivePreference(db, "user-1", "org-1");
    expect(prefs.orgId).toBe("org-1");
    expect(prefs.channels.sms.enabled).toBe(false);
  });

  it("lets an explicit stored user choice win over org defaults", async () => {
    const orgDoc = getDefaultNotificationPreference("org-1", "org-1");
    orgDoc.channels.email.frequency = "daily_digest";

    const userDoc = getDefaultNotificationPreference("user-1", "org-1");
    const explicit = applyPreferenceUpdate(userDoc, {
      channels: { email: { frequency: "weekly_digest" } },
    });

    const db = makeDb([
      [fullRow({ org_id: "org-1", preferences: explicit, version: 2 })],
      [{ org_id: "org-1", preferences: orgDoc, version: 2, updated_at: new Date() }],
    ]);
    const prefs = await getEffectivePreference(db, "user-1", "org-1");
    expect(prefs.channels.email.frequency).toBe("weekly_digest");
  });
});

describe("updateStoredPreference", () => {
  it("applies an update on top of the stored document", async () => {
    const stored = getDefaultNotificationPreference("user-1");
    const db = makeDb([
      [fullRow({ preferences: stored, version: 2 })],
      [fullRow({ preferences: { ...stored, channels: { ...stored.channels, email: { ...stored.channels.email, enabled: false } } }, version: 2 })],
    ]);
    const prefs = await updateStoredPreference(db, "user-1", {
      channels: { email: { enabled: false } },
    });
    expect(prefs.channels.email.enabled).toBe(false);
    expect(prefs.channels.push.enabled).toBe(true);
  });
});

describe("listLegacyPreferences", () => {
  it("returns only rows without a JSONB document", async () => {
    const db = makeDb([[fullRow(), fullRow({ user_id: "user-2", email_enabled: false })]]);
    const rows = await listLegacyPreferences(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].userId).toBe("user-1");
    expect(rows[1].userId).toBe("user-2");
    expect(rows[1].emailEnabled).toBe(false);
  });
});

describe("migration records", () => {
  it("creates and lists migration records", async () => {
    const db = makeDb([[], [{ user_id: "user-1", from_version: 1, to_version: 2, changes: { migrated: true }, status: "completed" }]]);
    await createMigrationRecord(db, {
      userId: "user-1",
      fromVersion: 1,
      toVersion: 2,
      changes: { migrated: true },
      status: "completed",
    });
    const records = await listMigrationRecords(db);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ userId: "user-1", fromVersion: 1, toVersion: 2, status: "completed" });
  });

  it("filters migration records by user", async () => {
    const db = makeDb([[]]);
    await listMigrationRecords(db, "user-1");
    const [, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["user-1"]);
  });
});

// ---- #300: documents saved before the whatsapp channel existed ---------------

/** A stored document as it looked before `whatsapp` was added. */
function legacyDocWithoutWhatsapp(userId: string): NotificationPreference {
  const doc = getDefaultNotificationPreference(userId) as unknown as {
    channels: Record<string, unknown>;
    categories: Record<string, { channels: string[] }>;
  };
  delete doc.channels.whatsapp;
  for (const category of Object.values(doc.categories)) {
    category.channels = category.channels.filter((c) => c !== "whatsapp");
  }
  return doc as unknown as NotificationPreference;
}

describe("legacy documents without a whatsapp channel", () => {
  it("upgrade user documents on read so WhatsApp follows SMS", async () => {
    const legacy = legacyDocWithoutWhatsapp("user-1");
    legacy.channels.sms.enabled = false;
    const db = makeDb([[fullRow({ preferences: legacy, version: 2 })]]);

    const stored = await getStoredPreference(db, "user-1");

    expect(stored?.preferences.channels.whatsapp.enabled).toBe(false);
    expect(stored?.preferences.categories.transaction.channels).toContain("whatsapp");
  });

  it("upgrade org defaults on read", async () => {
    const legacy = legacyDocWithoutWhatsapp("org-1");
    const db = makeDb([[{ org_id: "org-1", preferences: legacy, version: 2, updated_at: new Date() }]]);

    const prefs = await getOrgDefaultPreference(db, "org-1");

    expect(prefs?.channels.whatsapp.enabled).toBe(true);
    expect(prefs?.categories.transaction.channels).toContain("whatsapp");
  });
});
