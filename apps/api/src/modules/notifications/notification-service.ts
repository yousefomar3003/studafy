import { DOMAIN_EVENTS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { emit } from "../../lib/events/emitter";
import { decodeKeysetCursor, encodeKeysetCursor } from "../../lib/keyset-cursor";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotificationRow {
  id: string;
  school_id: string;
  user_id: string;
  notification_type: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListNotificationsParams {
  limit: number;
  cursor?: string;
  unreadOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The authenticated user's inbox, newest first, keyset-paginated on `(created_at, id)`.
 *
 * RLS supplies the recipient predicate (`user_id = app.current_user_id()`), so the caller only
 * scopes by school. The `unread_only` arm maps onto the partial unread index
 * `idx_notifications_school_user_unread`; the full-history arm uses
 * `idx_notifications_school_user_created`. Cursor stability is inherent to keyset pagination: the
 * boundary is the last row, not a position, so a notification inserted or marked read between two
 * page fetches cannot shift or duplicate rows mid-pagination.
 */
export async function listNotifications(
  tx: TransactionSql,
  schoolId: string,
  params: ListNotificationsParams,
): Promise<{ rows: NotificationRow[]; next_cursor: string | null }> {
  const unreadFilter = params.unreadOnly ? tx` AND read_at IS NULL` : tx``;

  const cursorFilter = params.cursor
    ? (() => {
        const { created_at, id } = decodeKeysetCursor(params.cursor);
        return tx` AND (created_at, id) < (${created_at}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  const limit = params.limit + 1; // fetch one extra to detect next page

  const rows = await tx<NotificationRow[]>`
    SELECT id, school_id, user_id, notification_type, title, body, metadata,
           read_at, created_at, updated_at
    FROM app.notifications
    WHERE school_id = ${schoolId}
      ${unreadFilter}
      ${cursorFilter}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `;

  const hasMore = rows.length > params.limit;
  const sliced = hasMore ? rows.slice(0, params.limit) : rows;
  const next_cursor =
    hasMore && sliced.length > 0
      ? encodeKeysetCursor(sliced[sliced.length - 1]!.created_at, sliced[sliced.length - 1]!.id)
      : null;

  return { rows: sliced, next_cursor };
}

/**
 * The recipient's unread count. RLS restricts to the authenticated user; the query is served by the
 * partial `idx_notifications_school_user_unread` index.
 */
export async function countUnread(tx: TransactionSql, schoolId: string): Promise<number> {
  const [row] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM app.notifications
    WHERE school_id = ${schoolId} AND read_at IS NULL
  `;
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Mark one notification read and return the recipient's fresh unread count.
 *
 * Idempotent: an already-read row matches zero updates and is reported back as a 200 with the
 * current count rather than a 404 — the resource exists, it is simply no longer unread. The
 * `notification.read` outbox event is raised only when this call actually transitions the row
 * (unread -> read), and carries the new count so a badge consumer can refresh without re-querying.
 *
 * A row that is neither owned nor present answers 404. RLS already hides anyone else's rows, so
 * "not yours" and "does not exist" are deliberately the same response.
 */
export async function markNotificationRead(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  notificationId: string,
): Promise<number> {
  const updated = await tx`
    UPDATE app.notifications
    SET read_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${notificationId}::uuid
      AND school_id = ${schoolId}
      AND read_at IS NULL
    RETURNING id
  `;

  if (updated.length === 0) {
    const exists = await tx<{ id: string }[]>`
      SELECT id FROM app.notifications
      WHERE id = ${notificationId}::uuid AND school_id = ${schoolId}
    `;
    if (exists.length === 0) {
      throw new HTTPException(404, { message: "Notification not found" });
    }
  }

  const unreadCount = await countUnread(tx, schoolId);

  if (updated.length > 0) {
    await emit(tx, DOMAIN_EVENTS.NOTIFICATION_READ, {
      userId,
      notificationId,
      unreadCount,
    });
  }

  return unreadCount;
}

/**
 * Mark every unread notification of the authenticated user read, and return the fresh unread count
 * (zero, absent a concurrent delivery). One `notification.allRead` event regardless of how many rows
 * transitioned — the fact is "the inbox was cleared", not "each row was read".
 */
export async function markAllRead(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
): Promise<number> {
  const result = await tx`
    UPDATE app.notifications
    SET read_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId} AND read_at IS NULL
  `;

  const unreadCount = await countUnread(tx, schoolId);

  if (result.count > 0) {
    await emit(tx, DOMAIN_EVENTS.NOTIFICATION_ALL_READ, { userId, unreadCount });
  }

  return unreadCount;
}
