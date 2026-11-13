import type { TransactionSql } from "postgres";

export interface NotificationQuietHours {
  start: string | null;
  end: string | null;
  timezone: string;
}

/** The caller's quiet hours, read in their own time zone, else the school's, else UTC. */
export async function getQuietHours(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
): Promise<NotificationQuietHours> {
  const [row] = await tx<NotificationQuietHours[]>`
    SELECT to_char(settings.quiet_hours_start, 'HH24:MI') AS start,
           to_char(settings.quiet_hours_end, 'HH24:MI') AS "end",
           coalesce(settings.timezone, school_settings.timezone, 'UTC') AS timezone
    FROM (SELECT 1) AS one
    LEFT JOIN app.user_notification_settings AS settings
      ON settings.user_id = ${userId}::uuid
     AND settings.school_id = ${schoolId}::uuid
    LEFT JOIN app.school_settings AS school_settings
      ON school_settings.school_id = ${schoolId}::uuid
  `;
  return row ?? { start: null, end: null, timezone: "UTC" };
}

/**
 * Set or clear the caller's quiet hours. A new settings row takes the school's time zone: the
 * column's own default is a fixed zone, which would silently move the window for a school
 * elsewhere.
 */
export async function setQuietHours(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  window: { start: string | null; end: string | null },
): Promise<NotificationQuietHours> {
  await tx`
    INSERT INTO app.user_notification_settings (
      user_id, school_id, quiet_hours_start, quiet_hours_end, timezone
    )
    SELECT ${userId}::uuid, ${schoolId}::uuid, ${window.start}::time, ${window.end}::time,
           coalesce(
             (SELECT timezone FROM app.school_settings WHERE school_id = ${schoolId}::uuid),
             'Asia/Amman'
           )
    ON CONFLICT (user_id) DO UPDATE SET
      quiet_hours_start = EXCLUDED.quiet_hours_start,
      quiet_hours_end = EXCLUDED.quiet_hours_end,
      updated_at = GREATEST(CURRENT_TIMESTAMP, app.user_notification_settings.created_at)
  `;
  return getQuietHours(tx, schoolId, userId);
}

/** How soon a second test notice may follow the first, per user. */
export const TEST_NOTIFICATION_INTERVAL_SECONDS = 20;

/**
 * Put a test notice in the caller's own inbox. The push consumer sends it to every phone the
 * caller is signed in on, ignoring their per-type switches and quiet hours (`metadata.test`), so
 * the button proves the phone can be reached. Returns null when the previous test was too recent.
 */
export async function createTestNotification(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  text: { title: string; body: string },
): Promise<{ id: string } | null> {
  const [recent] = await tx<{ id: string }[]>`
    SELECT id FROM app.notifications
    WHERE user_id = ${userId}::uuid
      AND (metadata ->> 'test') = 'true'
      AND created_at > CURRENT_TIMESTAMP - (${TEST_NOTIFICATION_INTERVAL_SECONDS}::int * interval '1 second')
    LIMIT 1
  `;
  if (recent) return null;

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
    VALUES (
      ${schoolId}::uuid, ${userId}::uuid, 'ADMIN_ANNOUNCEMENT'::app.notification_type,
      ${text.title}, ${text.body}, ${tx.json({ test: true, route: "/notifications" })}
    )
    RETURNING id
  `;
  return { id: row!.id };
}
