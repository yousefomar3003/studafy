import { publishAnnouncement } from "@studafy/announcements";
import { HTTPException } from "hono/http-exception";

import { decodeKeysetCursor, encodeKeysetCursor } from "../../lib/keyset-cursor";

import type { CreateAnnouncementBody } from "./schemas";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnnouncementListRow {
  id: string;
  school_id: string;
  created_by: string;
  created_by_name: string | null;
  title: string;
  body: string;
  mandatory: boolean;
  audience_type: "school" | "role" | "class";
  audience_role: string | null;
  audience_class_id: string | null;
  audience_class_code: string | null;
  status: "scheduled" | "published";
  scheduled_at: Date;
  published_at: Date | null;
  recipient_count: number;
  notified_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface ListAnnouncementsParams {
  limit: number;
  cursor?: string;
  status?: "scheduled" | "published";
}

// ---------------------------------------------------------------------------
// Shared row shape
// ---------------------------------------------------------------------------

/**
 * Joins the admin's display name, the targeted class's code (both nullable — a class join is
 * naturally absent for school/role audiences), and each row's reach stats off
 * app.announcement_recipients in one lateral subquery. `LEFT JOIN LATERAL` rather than a `GROUP BY`
 * because it stays correct — and zero, not absent — for a still-scheduled announcement with no
 * recipient rows yet.
 */
const ANNOUNCEMENT_SELECT = `
  a.id, a.school_id, a.created_by, u.display_name AS created_by_name,
  a.title, a.body, a.mandatory, a.audience_type, a.audience_role,
  a.audience_class_id, c.code AS audience_class_code,
  a.status, a.scheduled_at, a.published_at,
  coalesce(reach.recipient_count, 0) AS recipient_count,
  coalesce(reach.notified_count, 0) AS notified_count,
  a.created_at, a.updated_at
`;

async function selectAnnouncementById(
  tx: TransactionSql,
  schoolId: string,
  announcementId: string,
): Promise<AnnouncementListRow | null> {
  const rows = await tx<AnnouncementListRow[]>`
    SELECT ${tx.unsafe(ANNOUNCEMENT_SELECT)}
    FROM app.announcements AS a
    LEFT JOIN app.users AS u ON u.id = a.created_by AND u.school_id = a.school_id
    LEFT JOIN app.classes AS c ON c.id = a.audience_class_id AND c.school_id = a.school_id
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int AS recipient_count,
        count(*) FILTER (WHERE ar.notified_at IS NOT NULL)::int AS notified_count
      FROM app.announcement_recipients AS ar
      WHERE ar.announcement_id = a.id AND ar.school_id = a.school_id
    ) AS reach ON true
    WHERE a.id = ${announcementId}::uuid AND a.school_id = ${schoolId}::uuid
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Create + publish
// ---------------------------------------------------------------------------

/**
 * Creates an announcement and, when its instant is already due, publishes it in the same
 * transaction — so "compose and send now" is one atomic commit rather than a create that then
 * depends on a best-effort follow-up step (the cost SAD_21 documents for enqueueing after commit).
 * A future `scheduled_at` instead leaves the row for the workers' publish sweep
 * (apps/workers/src/queues/announcements) to claim later.
 */
export async function createAnnouncement(
  tx: TransactionSql,
  schoolId: string,
  createdBy: string,
  input: CreateAnnouncementBody,
  now: Date,
): Promise<AnnouncementListRow> {
  if (input.audience_type === "class") {
    // createAnnouncementBodySchema's superRefine already guarantees this at the HTTP boundary; the
    // check here is what lets TypeScript narrow audience_class_id past `string | undefined` rather
    // than trusting a fact proven three modules away.
    if (input.audience_class_id === undefined) {
      throw new Error("audience_class_id missing for audience_type 'class' past validation");
    }
    const [klass] = await tx<{ id: string }[]>`
      SELECT id FROM app.classes
      WHERE id = ${input.audience_class_id}::uuid AND school_id = ${schoolId}::uuid
    `;
    if (!klass) throw new HTTPException(404, { message: "Class not found" });
  }

  const scheduledAt =
    input.scheduled_at !== undefined && new Date(input.scheduled_at) > now
      ? new Date(input.scheduled_at)
      : now;

  const [created] = await tx<{ id: string }[]>`
    INSERT INTO app.announcements
      (school_id, created_by, title, body, mandatory, audience_type, audience_role,
       audience_class_id, status, scheduled_at)
    VALUES (
      ${schoolId}::uuid, ${createdBy}::uuid, ${input.title}, ${input.body}, ${input.mandatory},
      ${input.audience_type}, ${input.audience_role ?? null}::app.user_role,
      ${input.audience_class_id ?? null}::uuid, 'scheduled', ${scheduledAt}::timestamptz
    )
    RETURNING id
  `;
  const announcementId = created!.id;

  if (scheduledAt <= now) {
    await publishAnnouncement(tx, schoolId, announcementId, now);
  }

  const row = await selectAnnouncementById(tx, schoolId, announcementId);
  if (!row) throw new Error("Announcement vanished within its own creating transaction");
  return row;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listAnnouncements(
  tx: TransactionSql,
  schoolId: string,
  params: ListAnnouncementsParams,
): Promise<{ items: AnnouncementListRow[]; next_cursor: string | null }> {
  const position = params.cursor !== undefined ? decodeKeysetCursor(params.cursor) : null;

  const rows = await tx<AnnouncementListRow[]>`
    SELECT ${tx.unsafe(ANNOUNCEMENT_SELECT)}
    FROM app.announcements AS a
    LEFT JOIN app.users AS u ON u.id = a.created_by AND u.school_id = a.school_id
    LEFT JOIN app.classes AS c ON c.id = a.audience_class_id AND c.school_id = a.school_id
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int AS recipient_count,
        count(*) FILTER (WHERE ar.notified_at IS NOT NULL)::int AS notified_count
      FROM app.announcement_recipients AS ar
      WHERE ar.announcement_id = a.id AND ar.school_id = a.school_id
    ) AS reach ON true
    WHERE a.school_id = ${schoolId}::uuid
      AND (${params.status ?? null}::text IS NULL OR a.status = ${params.status ?? null}::text)
      AND (${position?.created_at ?? null}::timestamptz IS NULL
        OR (a.created_at, a.id) < (${position?.created_at ?? null}::timestamptz, ${position?.id ?? null}::uuid))
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${params.limit + 1}
  `;

  const hasMore = rows.length > params.limit;
  const items = hasMore ? rows.slice(0, params.limit) : rows;
  const last = items.at(-1);
  return {
    items,
    next_cursor: last ? encodeKeysetCursor(last.created_at, last.id) : null,
  };
}
