import {
  DIGEST_ELIGIBLE_NOTIFICATION_TYPES,
  MANDATORY_NOTIFICATION_TYPES,
  NOTIFICATION_TYPES,
} from "@studafy/constants";
import { NOTIFICATION_CHANNELS } from "@studafy/notification-templates";
import { HTTPException } from "hono/http-exception";

import { emitAuditLog } from "../../middleware/auditEmitter";

import type { NotificationPreference } from "./schemas";
import type { NotificationType } from "@studafy/constants";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotificationPreferences {
  preferences: NotificationPreference[];
  attendance_alert_threshold: number | null;
}

// notification_type/channel are plain strings, not the branded NotificationType/NotificationChannel
// unions, matching notification-service.ts's NotificationRow: the caller is the OpenAPI request
// body, already validated against notificationTypeSchema/notificationChannelSchema in schemas.ts,
// and the DB layer re-validates by casting to the Postgres enum on every query below.
export interface NotificationPreferenceUpdate {
  notification_type: string;
  channel: string;
  enabled?: boolean;
  digest?: boolean;
}

export interface UpdateNotificationPreferencesParams {
  preferences?: NotificationPreferenceUpdate[];
  attendance_alert_threshold?: number | null;
}

interface PreferenceRow {
  notification_type: string;
  channel: string;
  enabled: boolean;
  digest: boolean;
}

const ALL_TYPES = Object.values(NOTIFICATION_TYPES);
const ALL_CHANNELS = Object.values(NOTIFICATION_CHANNELS);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The authenticated user's full preference matrix, effective right now.
 *
 * Every (type, channel) pair is represented, whether or not a row exists for it — an absent row
 * means enabled: true, digest: false, the same default app.seed_default_notification_preferences
 * (000017) writes and apps/workers/.../dispatcher.ts's loadEnabledChannels already treats a missing
 * row as. Materializing the full cross product here rather than returning only the rows that exist
 * means a client never has to know that convention to render a complete toggle list.
 */
export async function getPreferences(
  tx: TransactionSql,
  userId: string,
): Promise<NotificationPreferences> {
  const rows = await tx<PreferenceRow[]>`
    SELECT notification_type::text, channel::text, enabled, digest
    FROM app.notification_preferences
    WHERE user_id = ${userId}::uuid
  `;
  const stored = new Map(rows.map((row) => [`${row.notification_type}:${row.channel}`, row]));

  const preferences: NotificationPreference[] = [];
  for (const notification_type of ALL_TYPES) {
    for (const channel of ALL_CHANNELS) {
      const row = stored.get(`${notification_type}:${channel}`);
      preferences.push({
        notification_type,
        channel,
        enabled: row?.enabled ?? true,
        digest: row?.digest ?? false,
        mandatory: MANDATORY_NOTIFICATION_TYPES.has(notification_type),
        digest_eligible:
          channel === NOTIFICATION_CHANNELS.EMAIL &&
          DIGEST_ELIGIBLE_NOTIFICATION_TYPES.has(notification_type),
      });
    }
  }

  const [settings] = await tx<{ attendance_alert_threshold: number | null }[]>`
    SELECT attendance_alert_threshold
    FROM app.user_notification_settings
    WHERE user_id = ${userId}::uuid
  `;

  return { preferences, attendance_alert_threshold: settings?.attendance_alert_threshold ?? null };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Reject a write the database would reject anyway, with a message that names the rule instead of a
 * raw constraint violation. ck_notification_preferences_mandatory_enabled,
 * ck_notification_preferences_digest_channel and ck_notification_preferences_digest_eligible
 * (migration 000083) enforce the same three rules at the database's arbiter of record — this is
 * defense in depth, not the only guard, so a caller that somehow bypassed this layer would still be
 * stopped, just with a less specific error.
 */
export function validateUpdate(update: NotificationPreferenceUpdate): void {
  const { notification_type, channel, enabled, digest } = update;
  // Already validated against notificationTypeSchema/notificationChannelSchema by the OpenAPI
  // request body parser — this cast just recovers the literal type the Set lookups below need.
  const type = notification_type as NotificationType;

  if (enabled === false && MANDATORY_NOTIFICATION_TYPES.has(type)) {
    throw new HTTPException(422, {
      message: `${notification_type} is mandatory and cannot be disabled.`,
    });
  }

  if (digest === true) {
    if (channel !== NOTIFICATION_CHANNELS.EMAIL) {
      throw new HTTPException(422, {
        message: "digest can only be enabled on the email channel.",
      });
    }
    if (!DIGEST_ELIGIBLE_NOTIFICATION_TYPES.has(type)) {
      throw new HTTPException(422, {
        message: `${notification_type} is not eligible for digest delivery.`,
      });
    }
  }
}

async function upsertPreference(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  current: NotificationPreference,
  update: NotificationPreferenceUpdate,
): Promise<void> {
  const enabled = update.enabled ?? current.enabled;
  const digest = update.digest ?? current.digest;

  await tx`
    INSERT INTO app.notification_preferences (
      school_id, user_id, notification_type, channel, enabled, digest
    ) VALUES (
      ${schoolId}::uuid,
      ${userId}::uuid,
      ${update.notification_type}::app.notification_type,
      ${update.channel}::app.notification_channel,
      ${enabled},
      ${digest}
    )
    ON CONFLICT (user_id, notification_type, channel) DO UPDATE SET
      enabled = ${enabled},
      digest = ${digest},
      updated_at = CURRENT_TIMESTAMP
  `;
}

/**
 * Set a personal attendance-alert threshold, or clear it with null.
 *
 * Only attendance_alert_threshold is touched on conflict — quiet hours, timezone and locale
 * (whichever of those the user has already set, if any) are left exactly as they were. A fresh row
 * takes their column defaults, the same as any first-time write to app.user_notification_settings.
 */
async function upsertAttendanceAlertThreshold(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  threshold: number | null,
): Promise<void> {
  await tx`
    INSERT INTO app.user_notification_settings (user_id, school_id, attendance_alert_threshold)
    VALUES (${userId}::uuid, ${schoolId}::uuid, ${threshold})
    ON CONFLICT (user_id) DO UPDATE SET
      attendance_alert_threshold = ${threshold},
      updated_at = CURRENT_TIMESTAMP
  `;
}

/**
 * Apply a batch of preference-cell and/or attendance-threshold changes, then return the resulting
 * matrix.
 *
 * Re-reads the matrix after writing rather than merging the patch in memory: the upserts below are
 * the only place COALESCE-style "leave unspecified fields alone" logic would otherwise have to be
 * reasoned about twice, and re-reading makes the response provably what the database now holds
 * instead of what this function assumed it wrote.
 */
export async function updatePreferences(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: UpdateNotificationPreferencesParams,
): Promise<NotificationPreferences> {
  const before = await getPreferences(tx, userId);
  const byKey = new Map(before.preferences.map((p) => [`${p.notification_type}:${p.channel}`, p]));

  const changedPreferences: {
    notification_type: string;
    channel: string;
    before: { enabled: boolean; digest: boolean };
    after: { enabled: boolean; digest: boolean };
  }[] = [];

  for (const update of params.preferences ?? []) {
    validateUpdate(update);
    const current = byKey.get(`${update.notification_type}:${update.channel}`);
    if (current === undefined) continue; // Unreachable: byKey covers every (type, channel) pair.

    await upsertPreference(tx, schoolId, userId, current, update);
    changedPreferences.push({
      notification_type: update.notification_type,
      channel: update.channel,
      before: { enabled: current.enabled, digest: current.digest },
      after: {
        enabled: update.enabled ?? current.enabled,
        digest: update.digest ?? current.digest,
      },
    });
  }

  if (params.attendance_alert_threshold !== undefined) {
    await upsertAttendanceAlertThreshold(tx, schoolId, userId, params.attendance_alert_threshold);
  }

  // The aggregate target is the preference owner, not any one cell -- the same reasoning
  // notification-service.ts's markAllRead gives for auditing an inbox sweep against the user id.
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "notification_preferences",
    targetId: userId,
    oldValues: {
      preferences: changedPreferences.map(({ notification_type, channel, before: b }) => ({
        notification_type,
        channel,
        ...b,
      })),
      ...(params.attendance_alert_threshold !== undefined
        ? { attendance_alert_threshold: before.attendance_alert_threshold }
        : {}),
    },
    newValues: {
      preferences: changedPreferences.map(({ notification_type, channel, after }) => ({
        notification_type,
        channel,
        ...after,
      })),
      ...(params.attendance_alert_threshold !== undefined
        ? { attendance_alert_threshold: params.attendance_alert_threshold }
        : {}),
    },
  });

  return getPreferences(tx, userId);
}
