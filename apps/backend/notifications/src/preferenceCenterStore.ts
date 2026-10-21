// DB-backed persistence for the notification preference center (#115).
// Stores the full preference document as JSONB on notification_preferences,
// org-level defaults on org_notification_preferences, and migration history on
// preference_migrations (see database/migrations/023_*.sql).

import {
  getDefaultNotificationPreference,
  resolveEffectivePreference,
  applyPreferenceUpdate,
  upgradeLegacyWhatsappPreference,
  type NotificationPreference,
  type PreferenceUpdate,
} from "./preferenceCenter.js";

export interface PreferenceDb {
  query(text: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount?: number }>;
}

export const PREFERENCE_VERSION_CURRENT = 2;

export interface StoredPreference {
  userId: string;
  orgId: string | null;
  version: number;
  preferences: NotificationPreference;
}

interface PreferenceRow {
  user_id: string;
  org_id: string | null;
  email_enabled: boolean;
  push_enabled: boolean;
  preferences: NotificationPreference | null;
  version: number;
  updated_at: Date;
}

interface OrgPreferenceRow {
  org_id: string;
  preferences: NotificationPreference;
  version: number;
  updated_at: Date;
}

function rowToStored(row: PreferenceRow): StoredPreference {
  return {
    userId: row.user_id,
    orgId: row.org_id,
    version: row.version,
    preferences: row.preferences
      ? upgradeLegacyWhatsappPreference(row.preferences)
      : getDefaultNotificationPreference(row.user_id, row.org_id ?? undefined),
  };
}

/**
 * Returns the user's stored preference document, or null when no row exists
 * (the caller decides whether to fall back to built-in defaults).
 */
export async function getStoredPreference(
  db: PreferenceDb,
  userId: string
): Promise<StoredPreference | null> {
  const result = await db.query(
    `SELECT user_id, org_id, email_enabled, push_enabled, preferences, version, updated_at
       FROM notification_preferences WHERE user_id = $1`,
    [userId]
  );
  if (result.rows.length === 0) return null;
  return rowToStored(result.rows[0] as PreferenceRow);
}

/** Insert or update the user's preference document. */
export async function upsertStoredPreference(
  db: PreferenceDb,
  userId: string,
  preferences: NotificationPreference,
  orgId?: string | null,
  version: number = PREFERENCE_VERSION_CURRENT
): Promise<StoredPreference> {
  const result = await db.query(
    `INSERT INTO notification_preferences
       (user_id, org_id, email_enabled, push_enabled, preferences, version, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE
       SET org_id = EXCLUDED.org_id,
           email_enabled = EXCLUDED.email_enabled,
           push_enabled = EXCLUDED.push_enabled,
           preferences = EXCLUDED.preferences,
           version = EXCLUDED.version,
           updated_at = CURRENT_TIMESTAMP
     RETURNING user_id, org_id, email_enabled, push_enabled, preferences, version, updated_at`,
    [
      userId,
      orgId ?? null,
      preferences.channels.email?.enabled ?? true,
      preferences.channels.push?.enabled ?? true,
      JSON.stringify(preferences),
      version,
    ]
  );
  return rowToStored(result.rows[0] as PreferenceRow);
}

export async function getOrgDefaultPreference(
  db: PreferenceDb,
  orgId: string
): Promise<NotificationPreference | null> {
  const result = await db.query(
    "SELECT org_id, preferences, version, updated_at FROM org_notification_preferences WHERE org_id = $1",
    [orgId]
  );
  if (result.rows.length === 0) return null;
  return upgradeLegacyWhatsappPreference((result.rows[0] as OrgPreferenceRow).preferences);
}

export async function upsertOrgDefaultPreference(
  db: PreferenceDb,
  orgId: string,
  preferences: NotificationPreference
): Promise<void> {
  await db.query(
    `INSERT INTO org_notification_preferences (org_id, preferences, version, updated_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (org_id) DO UPDATE
       SET preferences = EXCLUDED.preferences,
           version = EXCLUDED.version,
           updated_at = CURRENT_TIMESTAMP`,
    [orgId, JSON.stringify(preferences), PREFERENCE_VERSION_CURRENT]
  );
}

/**
 * Effective (inherited) preference for a user: org defaults are inherited
 * where the user has not made an explicit choice. When the user has no stored
 * document, built-in defaults are used as the base for inheritance.
 */
export async function getEffectivePreference(
  db: PreferenceDb,
  userId: string,
  orgId?: string
): Promise<NotificationPreference> {
  const [stored, orgDefaults] = await Promise.all([
    getStoredPreference(db, userId),
    orgId ? getOrgDefaultPreference(db, orgId) : Promise.resolve(null),
  ]);

  const base =
    stored?.preferences ?? getDefaultNotificationPreference(userId, orgId);
  return resolveEffectivePreference(base, orgDefaults ?? undefined);
}

/**
 * Apply a partial update to a user's preferences and persist the result.
 * Starts from the user's stored document (or built-in defaults) so org
 * defaults are never baked into user-level storage, avoiding double
 * inheritance on read.
 */
export async function updateStoredPreference(
  db: PreferenceDb,
  userId: string,
  update: PreferenceUpdate,
  orgId?: string
): Promise<NotificationPreference> {
  const stored = await getStoredPreference(db, userId);
  const base =
    stored?.preferences ?? getDefaultNotificationPreference(userId, orgId);
  const updated = applyPreferenceUpdate(base, update);
  await upsertStoredPreference(db, userId, updated, update.orgId ?? orgId ?? stored?.orgId ?? null);
  return updated;
}

/**
 * Legacy rows that predate the JSONB preference document (version 1). Used by
 * the migration tool to backfill `preferences`.
 */
export interface LegacyPreferenceRow {
  userId: string;
  emailEnabled: boolean;
  pushEnabled: boolean;
  updatedAt: Date;
}

export async function listLegacyPreferences(
  db: PreferenceDb,
  limit: number = 100
): Promise<LegacyPreferenceRow[]> {
  const result = await db.query(
    `SELECT user_id, email_enabled, push_enabled, updated_at
       FROM notification_preferences
      WHERE preferences IS NULL
      ORDER BY updated_at
      LIMIT $1`,
    [limit]
  );
  return (result.rows as Array<{
    user_id: string;
    email_enabled: boolean;
    push_enabled: boolean;
    updated_at: Date;
  }>).map((row) => ({
    userId: row.user_id,
    emailEnabled: row.email_enabled,
    pushEnabled: row.push_enabled,
    updatedAt: new Date(row.updated_at),
  }));
}

export interface MigrationRecordRow {
  userId: string;
  fromVersion: number;
  toVersion: number;
  changes: Record<string, unknown>;
  status: "pending" | "completed" | "failed";
}

export async function createMigrationRecord(
  db: PreferenceDb,
  record: MigrationRecordRow
): Promise<void> {
  await db.query(
    `INSERT INTO preference_migrations
       (user_id, from_version, to_version, changes, status, created_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
    [
      record.userId,
      record.fromVersion,
      record.toVersion,
      JSON.stringify(record.changes),
      record.status,
    ]
  );
}

export async function listMigrationRecords(
  db: PreferenceDb,
  userId?: string
): Promise<MigrationRecordRow[]> {
  const params: unknown[] = [];
  const where = userId ? ["user_id = $1"] : [];
  if (userId) params.push(userId);
  const result = await db.query(
    `SELECT user_id, from_version, to_version, changes, status
       FROM preference_migrations
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at`,
    params
  );
  return (result.rows as Array<{
    user_id: string;
    from_version: number;
    to_version: number;
    changes: Record<string, unknown>;
    status: "pending" | "completed" | "failed";
  }>).map((row) => ({
    userId: row.user_id,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    changes: row.changes,
    status: row.status,
  }));
}
