/**
 * Platform announcements (000212): Studafy-wide banners a super admin schedules from the console,
 * and the read every signed-in client makes to show the ones that are live for it.
 *
 * The table is global and reachable by studafy_admin only, so both sides run inside withSystemTx.
 * A console change is audited in the operator's home (platform) school with the operator as actor
 * and the change's reason in the row -- an announcement belongs to no school, so there is no
 * affected-school row (the same convention as plans and platform settings).
 */

import { ROLES, SCHOOL_STAFF_ROLES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { setTenantScope, withSystemTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { Database } from "../../../db/client";
import type { AuditEntry } from "../../../middleware/auditEmitter";
import type { Actor } from "../service";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

export const ANNOUNCEMENT_AUDIENCES = ["all", "staff"] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export const ANNOUNCEMENT_SEVERITIES = ["info", "warning", "maintenance"] as const;
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];

/** Where an announcement is in its window, computed at read time. */
export type AnnouncementState = "scheduled" | "live" | "ended";

interface AnnouncementRow {
  id: string;
  message_en: string;
  message_ar: string | null;
  audience: AnnouncementAudience;
  severity: AnnouncementSeverity;
  starts_at: Date;
  ends_at: Date;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface Announcement {
  id: string;
  messageEn: string;
  messageAr: string | null;
  audience: AnnouncementAudience;
  severity: AnnouncementSeverity;
  startsAt: string;
  endsAt: string;
  state: AnnouncementState;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** What a signed-in client needs to draw a banner -- no operator ids. */
export interface ActiveBanner {
  id: string;
  messageEn: string;
  messageAr: string | null;
  severity: AnnouncementSeverity;
  /** Maintenance banners stay until their window closes. */
  dismissible: boolean;
  endsAt: string;
}

const COLUMNS = (tx: TransactionSql) => tx`
  id, message_en, message_ar, audience, severity, starts_at, ends_at, created_by, updated_by,
  created_at, updated_at
`;

function stateOf(
  row: Pick<AnnouncementRow, "starts_at" | "ends_at">,
  now: Date,
): AnnouncementState {
  if (row.ends_at.getTime() <= now.getTime()) return "ended";
  if (row.starts_at.getTime() > now.getTime()) return "scheduled";
  return "live";
}

function toAnnouncement(row: AnnouncementRow, now: Date): Announcement {
  return {
    id: row.id,
    messageEn: row.message_en,
    messageAr: row.message_ar,
    audience: row.audience,
    severity: row.severity,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    state: stateOf(row, now),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** One audit row in the operator's home school, operator as actor. */
async function auditInHome(tx: TransactionSql, actor: Actor, entry: AuditEntry): Promise<void> {
  await setTenantScope(tx, actor.schoolId, actor.requestId);
  await tx`SELECT set_config('app.user_id', ${actor.userId}, true)`;
  await emitAuditLog(tx, entry);
}

function snapshot(row: AnnouncementRow) {
  return {
    message_en: row.message_en,
    message_ar: row.message_ar,
    audience: row.audience,
    severity: row.severity,
    starts_at: row.starts_at.toISOString(),
    ends_at: row.ends_at.toISOString(),
  };
}

function assertWindow(startsAt: Date, endsAt: Date): void {
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new HTTPException(400, { message: "The end time must be after the start time" });
  }
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

export interface AnnouncementListFilters {
  limit: number;
}

/** Live and scheduled first (soonest ending first), then the most recent ended ones. */
export async function listAnnouncements(
  database: Database,
  filters: AnnouncementListFilters,
  now: Date = new Date(),
): Promise<Announcement[]> {
  return withSystemTx(database, async (tx) => {
    const current = await tx<AnnouncementRow[]>`
      SELECT ${COLUMNS(tx)} FROM app.platform_announcements
      WHERE ends_at > ${now}
      ORDER BY starts_at, ends_at
    `;
    const ended = await tx<AnnouncementRow[]>`
      SELECT ${COLUMNS(tx)} FROM app.platform_announcements
      WHERE ends_at <= ${now}
      ORDER BY ends_at DESC
      LIMIT ${filters.limit}
    `;
    return [...current, ...ended].map((row) => toAnnouncement(row, now));
  });
}

export interface CreateAnnouncementInput {
  messageEn: string;
  messageAr: string | null;
  audience: AnnouncementAudience;
  severity: AnnouncementSeverity;
  startsAt: Date;
  endsAt: Date;
  reason: string;
}

export async function createAnnouncement(
  database: Database,
  input: CreateAnnouncementInput,
  actor: Actor,
  now: Date = new Date(),
): Promise<Announcement> {
  assertWindow(input.startsAt, input.endsAt);
  if (input.endsAt.getTime() <= now.getTime()) {
    throw new HTTPException(400, { message: "The end time must be in the future" });
  }
  return withSystemTx(database, async (tx) => {
    const [row] = await tx<AnnouncementRow[]>`
      INSERT INTO app.platform_announcements (
        message_en, message_ar, audience, severity, starts_at, ends_at, created_by, updated_by
      ) VALUES (
        ${input.messageEn}, ${input.messageAr}, ${input.audience}, ${input.severity},
        ${input.startsAt}, ${input.endsAt}, ${actor.userId}::uuid, ${actor.userId}::uuid
      )
      RETURNING ${COLUMNS(tx)}
    `;
    await auditInHome(tx, actor, {
      action: "insert",
      targetTable: "platform_announcements",
      targetId: row!.id,
      newValues: { ...snapshot(row!), reason: input.reason },
    });
    return toAnnouncement(row!, now);
  });
}

export interface UpdateAnnouncementInput {
  messageEn?: string;
  messageAr?: string | null;
  audience?: AnnouncementAudience;
  severity?: AnnouncementSeverity;
  startsAt?: Date;
  endsAt?: Date;
  /** Close the window now (sets ends_at to the current time). */
  endNow?: boolean;
  reason: string;
}

export async function updateAnnouncement(
  database: Database,
  announcementId: string,
  input: UpdateAnnouncementInput,
  actor: Actor,
  now: Date = new Date(),
): Promise<Announcement> {
  return withSystemTx(database, async (tx) => {
    const [current] = await tx<AnnouncementRow[]>`
      SELECT ${COLUMNS(tx)} FROM app.platform_announcements
      WHERE id = ${announcementId} FOR UPDATE
    `;
    if (!current) throw new HTTPException(404, { message: "Announcement not found" });
    if (stateOf(current, now) === "ended") {
      throw new HTTPException(409, { message: "An ended announcement can't be changed" });
    }

    const startsAt = input.startsAt ?? current.starts_at;
    let endsAt = input.endsAt ?? current.ends_at;
    if (input.endNow) {
      // A scheduled announcement ended before it began never shows; its window collapses to
      // [starts_at, starts_at + 1ms) so the window CHECK still holds.
      endsAt = now.getTime() > startsAt.getTime() ? now : new Date(startsAt.getTime() + 1);
    } else if (input.endsAt !== undefined && input.endsAt.getTime() <= now.getTime()) {
      throw new HTTPException(400, { message: "The end time must be in the future" });
    }
    assertWindow(startsAt, endsAt);

    const [row] = await tx<AnnouncementRow[]>`
      UPDATE app.platform_announcements SET
        message_en = ${input.messageEn ?? current.message_en},
        message_ar = ${input.messageAr === undefined ? current.message_ar : input.messageAr},
        audience = ${input.audience ?? current.audience},
        severity = ${input.severity ?? current.severity},
        starts_at = ${startsAt},
        ends_at = ${endsAt},
        updated_by = ${actor.userId}::uuid,
        updated_at = greatest(CURRENT_TIMESTAMP, created_at)
      WHERE id = ${announcementId}
      RETURNING ${COLUMNS(tx)}
    `;
    await auditInHome(tx, actor, {
      action: "update",
      targetTable: "platform_announcements",
      targetId: row!.id,
      oldValues: snapshot(current),
      newValues: { ...snapshot(row!), reason: input.reason, ended_early: input.endNow === true },
    });
    return toAnnouncement(row!, now);
  });
}

// ---------------------------------------------------------------------------
// Signed-in clients
// ---------------------------------------------------------------------------

/** Whether a user with these roles is in the announcement's audience. */
export function inAudience(audience: AnnouncementAudience, roles: readonly Role[]): boolean {
  if (audience === "all") return true;
  // Studafy's own staff see staff banners too: they support the schools that read them.
  return roles.some(
    (role) =>
      SCHOOL_STAFF_ROLES.includes(role) ||
      role === ROLES.SUPER_ADMIN ||
      role === ROLES.SUPPORT_AGENT,
  );
}

/** The banners live right now for a user with these roles, most severe first. */
export async function listActiveBanners(
  database: Database,
  roles: readonly Role[],
  now: Date = new Date(),
): Promise<ActiveBanner[]> {
  const rows = await withSystemTx(
    database,
    (tx) => tx<AnnouncementRow[]>`
      SELECT ${COLUMNS(tx)} FROM app.platform_announcements
      WHERE ends_at > ${now} AND starts_at <= ${now}
      ORDER BY CASE severity WHEN 'maintenance' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, starts_at DESC
      LIMIT 5
    `,
  );
  return rows
    .filter((row) => inAudience(row.audience, roles))
    .map((row) => ({
      id: row.id,
      messageEn: row.message_en,
      messageAr: row.message_ar,
      severity: row.severity,
      dismissible: row.severity !== "maintenance",
      endsAt: row.ends_at.toISOString(),
    }));
}
