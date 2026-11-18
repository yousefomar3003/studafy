import { ERROR_CODES, NOTIFICATION_TYPES } from "@studafy/constants";
import {
  AI_OPTIN_TERMS_VERSION,
  aiOptInPeriod,
  aiOptInTotal,
  firstOfNextMonth,
} from "@studafy/license-pricing";
import {
  isTemplateLocale,
  NOTIFICATION_CHANNELS,
  renderNotification,
} from "@studafy/notification-templates";

import { likeContains } from "../../lib/sql/like";
import { publishUserEntitlementChanges } from "../subscriptions/entitlements/entitlement-change-publisher";

import { resolveAiProgrammeValues } from "./ai-programme";
import { auditLicenseChange, licenseError } from "./context";
import { assignSeats, currentLicense, readLicense } from "./service";

import type { LicenseActor } from "./context";
import type { PendingRenewalStop } from "./overlap";
import type { Changed, LicenseRecord, LicenseStatus } from "./service";
import type { AiOptInSource, AiOptInStatus } from "@studafy/license-pricing";
import type { TemplateLocale } from "@studafy/notification-templates";
import type { TransactionSql } from "postgres";

/**
 * Student AI opt-in and programme seats (phase 2 of the Student AI programme, migration 000235,
 * docs/billing/ai-programme.md).
 *
 * The school (ORG_ADMIN / PRINCIPAL, license:manage) opens a window on its licence for an academic
 * year, optionally for some grades or sections only. While it is open, a parent opts their own child
 * in from the app (studentAi:optIn), or the school records it on the parent's behalf with a note.
 * Either way the opt-in is committed for the rest of the school's academic year -- months follow
 * that year, never an assumed 10 -- at the price parents see from the licence's programme values,
 * and it cannot be undone: the only way it ends is the student leaving the school, when the school
 * transfers the seat to another student or releases it from the next month.
 *
 * Seats. Each active opt-in holds a seat on the licence (app.license_seats, through assignSeats, so
 * Student AI unlocks through the entitlement path). Since 000252 (owner, 2026-11-18) that is a
 * programme seat, outside the seats the school bought on its licence: no minimum, no seat request,
 * no waiting. It covers the student only in the months the school has paid Studafy for, as parents
 * pay their tuition (the weekly statements, 000251). A student who already held a seat the school
 * bought keeps it, now held by the programme.
 */

/** Statuses a window can be opened on, and opt-ins taken on: the licence takes seats. */
const OPEN_FOR_OPT_IN: ReadonlySet<LicenseStatus> = new Set(["awaiting_payment", "active"]);
/** A student who is no longer at the school (app.set_student_left_at, 000170). */
const LEFT_STATUSES = ["graduated", "withdrawn", "archived"] as const;

// ---------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------

export interface PersonRef {
  userId: string;
  name: string;
}

export interface AiOptInWindowView {
  id: string;
  licenseId: string;
  academicYear: { id: string; name: string; startsOn: string; endsOn: string };
  opensOn: string;
  closesOn: string;
  /** scheduled: not open yet; open: parents can opt in today; ended: past its last day; closed. */
  state: "scheduled" | "open" | "ended" | "closed";
  note: string | null;
  /** Empty: every enrolled student of the year. */
  gradeLevels: { id: string; name: string }[];
  sections: { id: string; name: string }[];
  openedBy: PersonRef;
  openedAt: string;
  closedBy: PersonRef | null;
  closedAt: string | null;
}

export interface AiOptInView {
  id: string;
  studentId: string;
  studentName: string;
  academicYearId: string;
  licenseId: string;
  windowId: string | null;
  source: AiOptInSource;
  /** The parent who confirmed it (source parent). */
  parent: PersonRef | null;
  recordedBy: PersonRef;
  note: string | null;
  termsVersion: string;
  optedInAt: string;
  startMonth: string;
  endMonth: string;
  months: number;
  currencyCode: string;
  minorUnit: number;
  monthlyPriceMinor: number;
  totalMinor: number;
  seatId: string | null;
  seatAssignedAt: string | null;
  status: AiOptInStatus;
  endedAt: string | null;
  endNote: string | null;
  releasedEffectiveMonth: string | null;
  transferredToId: string | null;
  transferredFromId: string | null;
}

interface WindowRow {
  id: string;
  license_id: string;
  academic_year_id: string;
  academic_year_name: string;
  ay_starts_on: string;
  ay_ends_on: string;
  opens_on: string;
  closes_on: string;
  note: string | null;
  opened_by: string;
  opened_by_name: string;
  opened_at: Date;
  closed_by: string | null;
  closed_by_name: string | null;
  closed_at: Date | null;
}

const WINDOW_COLUMNS = (tx: TransactionSql) => tx`
  w.id::text AS id, w.license_id::text AS license_id, w.academic_year_id::text AS academic_year_id,
  ay.name AS academic_year_name, ay.starts_on::text AS ay_starts_on, ay.ends_on::text AS ay_ends_on,
  w.opens_on::text AS opens_on, w.closes_on::text AS closes_on, w.note,
  w.opened_by::text AS opened_by, COALESCE(ou.display_name, ou.email) AS opened_by_name, w.opened_at,
  w.closed_by::text AS closed_by, COALESCE(cu.display_name, cu.email) AS closed_by_name, w.closed_at
`;

const WINDOW_FROM = (tx: TransactionSql) => tx`
  FROM app.ai_optin_windows AS w
  JOIN app.academic_years AS ay ON ay.id = w.academic_year_id AND ay.school_id = w.school_id
  JOIN app.users AS ou ON ou.id = w.opened_by AND ou.school_id = w.school_id
  LEFT JOIN app.users AS cu ON cu.id = w.closed_by AND cu.school_id = w.school_id
`;

function windowState(row: WindowRow, today: string): AiOptInWindowView["state"] {
  if (row.closed_at) return "closed";
  if (today < row.opens_on) return "scheduled";
  if (today > row.closes_on) return "ended";
  return "open";
}

async function toWindowView(
  tx: TransactionSql,
  row: WindowRow,
  today: string,
): Promise<AiOptInWindowView> {
  const scopes = await tx<
    { grade_level_id: string | null; section_id: string | null; name: string }[]
  >`
    SELECT sc.grade_level_id::text AS grade_level_id, sc.section_id::text AS section_id,
           COALESCE(g.name, concat_ws(' ', sg.name, sec.name)) AS name
    FROM app.ai_optin_window_scopes AS sc
    LEFT JOIN app.grade_levels AS g ON g.id = sc.grade_level_id AND g.school_id = sc.school_id
    LEFT JOIN app.sections AS sec ON sec.id = sc.section_id AND sec.school_id = sc.school_id
    LEFT JOIN app.grade_levels AS sg ON sg.id = sec.grade_level_id AND sg.school_id = sec.school_id
    WHERE sc.school_id = current_setting('app.school_id')::uuid AND sc.window_id = ${row.id}::uuid
    ORDER BY name
  `;
  return {
    id: row.id,
    licenseId: row.license_id,
    academicYear: {
      id: row.academic_year_id,
      name: row.academic_year_name,
      startsOn: row.ay_starts_on,
      endsOn: row.ay_ends_on,
    },
    opensOn: row.opens_on,
    closesOn: row.closes_on,
    state: windowState(row, today),
    note: row.note,
    gradeLevels: scopes
      .filter((s) => s.grade_level_id)
      .map((s) => ({ id: s.grade_level_id!, name: s.name })),
    sections: scopes.filter((s) => s.section_id).map((s) => ({ id: s.section_id!, name: s.name })),
    openedBy: { userId: row.opened_by, name: row.opened_by_name },
    openedAt: row.opened_at.toISOString(),
    closedBy: row.closed_by ? { userId: row.closed_by, name: row.closed_by_name ?? "" } : null,
    closedAt: row.closed_at?.toISOString() ?? null,
  };
}

interface OptInRow {
  id: string;
  student_id: string;
  student_name: string;
  academic_year_id: string;
  license_id: string;
  window_id: string | null;
  source: AiOptInSource;
  parent_user_id: string | null;
  parent_name: string | null;
  recorded_by: string;
  recorded_by_name: string;
  note: string | null;
  terms_version: string;
  opted_in_at: Date;
  start_month: string;
  end_month: string;
  months: number;
  currency_code: string;
  minor_unit: number;
  monthly_price_minor: string;
  total_minor: string;
  seat_id: string | null;
  seat_assigned_at: Date | null;
  status: AiOptInStatus;
  ended_at: Date | null;
  end_note: string | null;
  released_effective_month: string | null;
  transferred_to_id: string | null;
  transferred_from_id: string | null;
}

const OPT_IN_COLUMNS = (tx: TransactionSql) => tx`
  o.id::text AS id, o.student_id::text AS student_id,
  COALESCE(NULLIF(btrim(concat_ws(' ', st.first_name, st.last_name)), ''), 'Student') AS student_name,
  o.academic_year_id::text AS academic_year_id, o.license_id::text AS license_id,
  o.window_id::text AS window_id, o.source, o.parent_user_id::text AS parent_user_id,
  COALESCE(pu.display_name, pu.email) AS parent_name,
  o.recorded_by::text AS recorded_by, COALESCE(ru.display_name, ru.email) AS recorded_by_name,
  o.note, o.terms_version, o.opted_in_at, o.start_month::text AS start_month,
  o.end_month::text AS end_month, o.months, c.code AS currency_code, c.minor_unit::int AS minor_unit,
  o.monthly_price_minor::text AS monthly_price_minor, o.total_minor::text AS total_minor,
  o.seat_id::text AS seat_id, o.seat_assigned_at, o.status, o.ended_at, o.end_note,
  o.released_effective_month::text AS released_effective_month,
  o.transferred_to_id::text AS transferred_to_id, o.transferred_from_id::text AS transferred_from_id
`;

const OPT_IN_FROM = (tx: TransactionSql) => tx`
  FROM app.ai_optins AS o
  JOIN app.students AS st ON st.id = o.student_id AND st.school_id = o.school_id
  JOIN app.currencies AS c ON c.id = o.currency_id
  JOIN app.users AS ru ON ru.id = o.recorded_by AND ru.school_id = o.school_id
  LEFT JOIN app.users AS pu ON pu.id = o.parent_user_id AND pu.school_id = o.school_id
`;

function toOptInView(row: OptInRow): AiOptInView {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name,
    academicYearId: row.academic_year_id,
    licenseId: row.license_id,
    windowId: row.window_id,
    source: row.source,
    parent: row.parent_user_id ? { userId: row.parent_user_id, name: row.parent_name ?? "" } : null,
    recordedBy: { userId: row.recorded_by, name: row.recorded_by_name },
    note: row.note,
    termsVersion: row.terms_version,
    optedInAt: row.opted_in_at.toISOString(),
    startMonth: row.start_month,
    endMonth: row.end_month,
    months: row.months,
    currencyCode: row.currency_code,
    minorUnit: row.minor_unit,
    monthlyPriceMinor: Number(row.monthly_price_minor),
    totalMinor: Number(row.total_minor),
    seatId: row.seat_id,
    seatAssignedAt: row.seat_assigned_at?.toISOString() ?? null,
    status: row.status,
    endedAt: row.ended_at?.toISOString() ?? null,
    endNote: row.end_note,
    releasedEffectiveMonth: row.released_effective_month,
    transferredToId: row.transferred_to_id,
    transferredFromId: row.transferred_from_id,
  };
}

export async function readOptIn(
  tx: TransactionSql,
  optInId: string,
  options: { forUpdate?: boolean } = {},
): Promise<AiOptInView | null> {
  const [row] = await tx<OptInRow[]>`
    SELECT ${OPT_IN_COLUMNS(tx)} ${OPT_IN_FROM(tx)}
    WHERE o.school_id = current_setting('app.school_id')::uuid AND o.id = ${optInId}::uuid
    ${options.forUpdate ? tx`FOR UPDATE OF o` : tx``}
  `;
  return row ? toOptInView(row) : null;
}

// ---------------------------------------------------------------------------------------------------
// School context: today, the programme's price, windows
// ---------------------------------------------------------------------------------------------------

/**
 * The armed school's local date (its school_settings timezone, UTC without one) at `now`:
 * app.school_today, the one definition of a school's "today" (QA-044).
 */
export async function schoolToday(tx: TransactionSql, now: Date): Promise<string> {
  const [row] = await tx<{ today: string }[]>`
    SELECT app.school_today(${now}::timestamptz)::text AS today
  `;
  return row!.today;
}

export interface OptInProgramme {
  currencyId: string;
  currencyCode: string;
  minorUnit: number;
  /** What parents see per month; null when the licence's currency has no price. */
  monthlyPriceMinor: number | null;
  minSeats: number;
}

/** The parent price and minimum seats a licence was signed with (its programme stamp, 000234). */
export async function optInProgramme(
  tx: TransactionSql,
  license: LicenseRecord,
): Promise<OptInProgramme> {
  const values = await resolveAiProgrammeValues(
    tx,
    { versionId: license.aiProgrammeVersionId, overrideId: license.aiProgrammeOverrideId },
    license.currencyCode,
  );
  const [currency] = await tx<{ minor_unit: number }[]>`
    SELECT minor_unit::int AS minor_unit FROM app.currencies WHERE id = ${license.currencyId}::uuid
  `;
  return {
    currencyId: license.currencyId,
    currencyCode: license.currencyCode,
    minorUnit: currency?.minor_unit ?? 2,
    monthlyPriceMinor: values.parentPriceMinor,
    minSeats: values.minSeats,
  };
}

/** The school's latest window (open first), or null. */
async function latestWindowRow(tx: TransactionSql): Promise<WindowRow | null> {
  const [row] = await tx<WindowRow[]>`
    SELECT ${WINDOW_COLUMNS(tx)} ${WINDOW_FROM(tx)}
    WHERE w.school_id = current_setting('app.school_id')::uuid
    ORDER BY w.closed_at IS NULL DESC, w.opened_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

async function windowRow(
  tx: TransactionSql,
  windowId: string,
  options: { forUpdate?: boolean } = {},
): Promise<WindowRow | null> {
  const [row] = await tx<WindowRow[]>`
    SELECT ${WINDOW_COLUMNS(tx)} ${WINDOW_FROM(tx)}
    WHERE w.school_id = current_setting('app.school_id')::uuid AND w.id = ${windowId}::uuid
    ${options.forUpdate ? tx`FOR UPDATE OF w` : tx``}
  `;
  return row ?? null;
}

/** The window parents can opt in through today, or null. */
async function openWindowRow(tx: TransactionSql, today: string): Promise<WindowRow | null> {
  const [row] = await tx<WindowRow[]>`
    SELECT ${WINDOW_COLUMNS(tx)} ${WINDOW_FROM(tx)}
    WHERE w.school_id = current_setting('app.school_id')::uuid
      AND w.closed_at IS NULL
      AND w.opens_on <= ${today}::date AND w.closes_on >= ${today}::date
    LIMIT 1
  `;
  return row ?? null;
}

/**
 * Students the window lets opt in, as a condition on `s` (app.students): enrolled, and in one of its
 * grades or sections for its academic year when it names any.
 */
function eligibleIn(tx: TransactionSql, windowId: string, academicYearId: string) {
  return tx`
    s.status = 'enrolled'
    AND (
      NOT EXISTS (
        SELECT 1 FROM app.ai_optin_window_scopes AS sc
        WHERE sc.school_id = s.school_id AND sc.window_id = ${windowId}::uuid
      )
      OR EXISTS (
        SELECT 1
        FROM app.student_sections AS ss
        JOIN app.sections AS sec ON sec.id = ss.section_id AND sec.school_id = ss.school_id
        JOIN app.ai_optin_window_scopes AS sc
          ON sc.school_id = ss.school_id AND sc.window_id = ${windowId}::uuid
         AND (sc.section_id = sec.id OR sc.grade_level_id = sec.grade_level_id)
        WHERE ss.school_id = s.school_id
          AND ss.student_id = s.id
          AND ss.academic_year_id = ${academicYearId}::uuid
      )
    )
  `;
}

async function schoolLocale(tx: TransactionSql): Promise<TemplateLocale> {
  const [settings] = await tx<{ locale: string | null }[]>`
    SELECT locale FROM app.school_settings WHERE school_id = current_setting('app.school_id')::uuid
  `;
  return isTemplateLocale(settings?.locale ?? "") ? (settings!.locale as TemplateLocale) : "en";
}

// ---------------------------------------------------------------------------------------------------
// Seats: every opt-in gets one (a programme seat, 000252)
// ---------------------------------------------------------------------------------------------------

const NO_CHANGE = { versions: new Map<string, number>(), pending: [] as PendingRenewalStop[] };

/**
 * Give a seat to every active opt-in on the licence that waits for one, oldest first. A student who
 * already holds a seat on the licence (assigned by the school before) keeps that one, now held by the
 * programme -- the school paid for it on its licence. Everyone else gets a programme seat (000252):
 * no minimum, no seat request, no waiting for capacity. Returns how many were seated.
 *
 * Runs as whoever acted: a parent's transaction sees only their own child's opt-ins (RLS), which is
 * all a parent's opt-in can seat; the school's and the super admin's see them all.
 */
export async function fillWaitingOptInSeats(
  tx: TransactionSql,
  schoolId: string,
  licenseId: string,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<Changed<number>> {
  const license = await readLicense(tx, licenseId, { forUpdate: true });
  if (!license || !OPEN_FOR_OPT_IN.has(license.status)) {
    return { result: 0, ...NO_CHANGE };
  }
  const waiting = await tx<{ id: string; user_id: string; seat_id: string | null }[]>`
    SELECT o.id::text AS id, s.user_id::text AS user_id, seat.id::text AS seat_id
    FROM app.ai_optins AS o
    JOIN app.students AS s ON s.id = o.student_id AND s.school_id = o.school_id
    LEFT JOIN app.license_seats AS seat
      ON seat.school_id = o.school_id AND seat.license_id = o.license_id
     AND seat.audience = 'student' AND seat.student_id = o.student_id
     AND seat.unassigned_at IS NULL
     AND NOT app.ai_optin_seat_locked(seat.id)
    WHERE o.school_id = current_setting('app.school_id')::uuid
      AND o.license_id = ${licenseId}::uuid
      AND o.status = 'active'
      AND o.seat_id IS NULL
    ORDER BY o.opted_in_at, o.id
  `;
  if (waiting.length === 0) return { result: 0, ...NO_CHANGE };

  const link = async (optInId: string, seatId: string) => {
    await tx`
      UPDATE app.ai_optins
      SET seat_id = ${seatId}::uuid, seat_assigned_at = CURRENT_TIMESTAMP,
          updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
      WHERE school_id = current_setting('app.school_id')::uuid AND id = ${optInId}::uuid
    `;
    await auditLicenseChange(tx, schoolId, actor, {
      action: "update",
      targetTable: "ai_optins",
      targetId: optInId,
      oldValues: { seat_id: null },
      newValues: { seat_id: seatId },
    });
  };

  let seated = 0;
  for (const row of waiting.filter((w) => w.seat_id)) {
    await link(row.id, row.seat_id!);
    seated += 1;
  }

  // Everyone else gets a programme seat at once (000252): outside the licence's priced capacity,
  // covering the student in the months the school pays for on its weekly statements.
  const toSeat = waiting.filter((w) => !w.seat_id);
  if (toSeat.length === 0) return { result: seated, ...NO_CHANGE };

  const changed = await assignSeats(
    tx,
    schoolId,
    licenseId,
    { audience: "student", userIds: toSeat.map((w) => w.user_id), programme: true },
    actor,
    now,
  );
  const byUser = new Map(toSeat.map((w) => [w.user_id, w.id]));
  for (const seat of changed.result.assigned) {
    const optInId = byUser.get(seat.userId);
    if (optInId) {
      await link(optInId, seat.seatId);
      seated += 1;
    }
  }
  return { result: seated, versions: changed.versions, pending: changed.pending };
}

// ---------------------------------------------------------------------------------------------------
// The school: overview, windows
// ---------------------------------------------------------------------------------------------------

export interface SchoolAiOptInOverview {
  /** The licence opt-ins fill, or null when the school has none it could open a window on. */
  license: {
    id: string;
    status: LicenseStatus;
    studentSeats: number;
    assignedStudentSeats: number;
    commitment: LicenseRecord["commitment"];
  } | null;
  programme: {
    currencyCode: string;
    minorUnit: number;
    monthlyPriceMinor: number | null;
    minSeats: number;
  } | null;
  window: AiOptInWindowView | null;
  /** The months and total a student opting in today would commit to (null without a window). */
  pricingToday: { startMonth: string; endMonth: string; months: number; totalMinor: number } | null;
  counts: {
    eligible: number;
    optedIn: number;
    waitingForSeat: number;
    released: number;
    transferred: number;
  };
  seatsNeeded: number;
  openSeatRequest: { id: string; studentSeats: number | null; createdAt: string } | null;
  /** Why a window cannot be opened now, if it cannot. */
  blocker: "no_licence" | "no_student_tier" | "no_price" | "no_academic_year" | null;
  termsVersion: string;
  today: string;
}

/** The armed school's current academic year: the active one, else the latest that has started. */
async function currentAcademicYear(
  tx: TransactionSql,
  today: string,
): Promise<{ id: string; name: string; starts_on: string; ends_on: string } | null> {
  const [row] = await tx<{ id: string; name: string; starts_on: string; ends_on: string }[]>`
    SELECT id::text AS id, name, starts_on::text AS starts_on, ends_on::text AS ends_on
    FROM app.academic_years
    WHERE school_id = current_setting('app.school_id')::uuid
      AND ends_on >= ${today}::date
    ORDER BY (status = 'active') DESC, starts_on
    LIMIT 1
  `;
  return row ?? null;
}

export async function schoolAiOptInOverview(
  tx: TransactionSql,
  now: Date = new Date(),
): Promise<SchoolAiOptInOverview> {
  const today = await schoolToday(tx, now);
  const latest = await latestWindowRow(tx);
  const license = latest ? await readLicense(tx, latest.license_id) : await currentLicense(tx);
  const programme = license ? await optInProgramme(tx, license) : null;
  const window = latest ? await toWindowView(tx, latest, today) : null;
  const year = latest
    ? { starts_on: latest.ay_starts_on, ends_on: latest.ay_ends_on, id: latest.academic_year_id }
    : await currentAcademicYear(tx, today);

  let blocker: SchoolAiOptInOverview["blocker"] = null;
  const current = await currentLicense(tx);
  if (!current || !OPEN_FOR_OPT_IN.has(current.status)) blocker = "no_licence";
  else if (!current.studentPlanId) blocker = "no_student_tier";
  else if ((await optInProgramme(tx, current)).monthlyPriceMinor === null) blocker = "no_price";
  else if (!(await currentAcademicYear(tx, today))) blocker = "no_academic_year";

  const [counts] = year
    ? await tx<
        {
          eligible: number;
          opted_in: number;
          waiting: number;
          released: number;
          transferred: number;
        }[]
      >`
        SELECT
          ${
            latest
              ? tx`(SELECT count(*)::int FROM app.students AS s
                   WHERE s.school_id = current_setting('app.school_id')::uuid
                     AND ${eligibleIn(tx, latest.id, latest.academic_year_id)})`
              : tx`(SELECT count(*)::int FROM app.students AS s
                   WHERE s.school_id = current_setting('app.school_id')::uuid
                     AND s.status = 'enrolled')`
          } AS eligible,
          count(*) FILTER (WHERE o.status = 'active')::int AS opted_in,
          count(*) FILTER (WHERE o.status = 'active' AND o.seat_id IS NULL)::int AS waiting,
          count(*) FILTER (WHERE o.status = 'released')::int AS released,
          count(*) FILTER (WHERE o.status = 'transferred')::int AS transferred
        FROM app.ai_optins AS o
        WHERE o.school_id = current_setting('app.school_id')::uuid
          AND o.academic_year_id = ${year.id}::uuid
      `
    : [];

  const [request] = license
    ? await tx<{ id: string; student_seats: number | null; created_at: Date }[]>`
        SELECT id::text AS id, student_seats, created_at FROM app.license_change_requests
        WHERE school_id = current_setting('app.school_id')::uuid
          AND license_id = ${license.id}::uuid AND source = 'ai_optin' AND status = 'open'
      `
    : [];
  const [assigned] = license
    ? await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM app.license_seats
        WHERE school_id = current_setting('app.school_id')::uuid AND license_id = ${license.id}::uuid
          AND audience = 'student' AND unassigned_at IS NULL AND NOT programme
      `
    : [];
  const period =
    window && window.state !== "closed"
      ? aiOptInPeriod({ startsOn: year!.starts_on, endsOn: year!.ends_on }, today)
      : null;

  return {
    license: license
      ? {
          id: license.id,
          status: license.status,
          studentSeats: license.studentSeats,
          assignedStudentSeats: assigned?.n ?? 0,
          commitment: license.commitment,
        }
      : null,
    programme: programme
      ? {
          currencyCode: programme.currencyCode,
          minorUnit: programme.minorUnit,
          monthlyPriceMinor: programme.monthlyPriceMinor,
          minSeats: programme.minSeats,
        }
      : null,
    window,
    pricingToday:
      period && programme?.monthlyPriceMinor != null
        ? { ...period, totalMinor: aiOptInTotal(programme.monthlyPriceMinor, period.months) }
        : null,
    counts: {
      eligible: counts?.eligible ?? 0,
      optedIn: counts?.opted_in ?? 0,
      waitingForSeat: counts?.waiting ?? 0,
      released: counts?.released ?? 0,
      transferred: counts?.transferred ?? 0,
    },
    // Opt-ins take programme seats outside the licence's (000252): the licence needs none for them.
    seatsNeeded: 0,
    openSeatRequest: request
      ? {
          id: request.id,
          studentSeats: request.student_seats,
          createdAt: request.created_at.toISOString(),
        }
      : null,
    blocker,
    termsVersion: AI_OPTIN_TERMS_VERSION,
    today,
  };
}

export interface OpenWindowInput {
  academicYearId?: string;
  opensOn: string;
  closesOn: string;
  gradeLevelIds?: string[];
  sectionIds?: string[];
  note?: string | null;
  /** No longer required (000252: opt-ins take programme seats, with no minimum). */
  acknowledgeMinimumSeats?: boolean;
}

/**
 * Open a window on the school's current licence. The licence must take seats (awaiting payment or
 * active) and sell a student tier, with a parent price in its currency, and the school must bill
 * Student AI on tuition through Studafy (auto-billing). Opt-ins take programme seats, with no
 * minimum (000252). A window past its last day that was never closed is closed now; one still
 * current must be closed first.
 */
export async function openWindow(
  tx: TransactionSql,
  schoolId: string,
  input: OpenWindowInput,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<AiOptInWindowView> {
  const invalid = () => licenseError(422, ERROR_CODES.AI_OPTIN_WINDOW_INVALID, actor.locale);
  // Studafy sees what parents paid only when it bills Student AI on their tuition (000252).
  const [billing] = await tx<{ auto_billing: boolean }[]>`
    SELECT auto_billing FROM app.student_ai_billing_settings
    WHERE school_id = current_setting('app.school_id')::uuid
  `;
  if (billing && !billing.auto_billing) {
    throw licenseError(409, ERROR_CODES.AI_OPTIN_AUTO_BILLING_REQUIRED, actor.locale);
  }
  const license = await currentLicense(tx, { forUpdate: true });
  if (!license || !OPEN_FOR_OPT_IN.has(license.status) || !license.studentPlanId) {
    throw licenseError(409, ERROR_CODES.AI_OPTIN_NO_LICENCE, actor.locale);
  }
  const programme = await optInProgramme(tx, license);
  if (programme.monthlyPriceMinor === null) {
    throw licenseError(409, ERROR_CODES.AI_OPTIN_PRICE_MISSING, actor.locale);
  }
  const today = await schoolToday(tx, now);
  const [year] = input.academicYearId
    ? await tx<{ id: string; starts_on: string; ends_on: string }[]>`
        SELECT id::text AS id, starts_on::text AS starts_on, ends_on::text AS ends_on
        FROM app.academic_years
        WHERE school_id = current_setting('app.school_id')::uuid AND id = ${input.academicYearId}::uuid
      `
    : [await currentAcademicYear(tx, today)];
  if (!year) throw invalid();
  if (
    input.closesOn < input.opensOn ||
    input.closesOn < today ||
    input.closesOn > year.ends_on ||
    input.opensOn > year.ends_on
  ) {
    throw invalid();
  }
  const gradeLevelIds = [...new Set(input.gradeLevelIds ?? [])];
  const sectionIds = [...new Set(input.sectionIds ?? [])];
  if (gradeLevelIds.length > 0) {
    const [found] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.grade_levels
      WHERE school_id = current_setting('app.school_id')::uuid AND id = ANY(${gradeLevelIds}::uuid[])
    `;
    if ((found?.n ?? 0) !== gradeLevelIds.length) throw invalid();
  }
  if (sectionIds.length > 0) {
    const [found] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.sections
      WHERE school_id = current_setting('app.school_id')::uuid AND id = ANY(${sectionIds}::uuid[])
        AND academic_year_id = ${year.id}::uuid
    `;
    if ((found?.n ?? 0) !== sectionIds.length) throw invalid();
  }

  // A window left open past its last day closes now, so a new one can open.
  const ended = await tx<{ id: string }[]>`
    UPDATE app.ai_optin_windows
    SET closed_at = CURRENT_TIMESTAMP, closed_by = ${actor.userId}::uuid,
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid
      AND closed_at IS NULL AND closes_on < ${today}::date
    RETURNING id::text AS id
  `;
  for (const row of ended) {
    await auditLicenseChange(tx, schoolId, actor, {
      action: "update",
      targetTable: "ai_optin_windows",
      targetId: row.id,
      oldValues: { closed_at: null },
      newValues: { closed: "ended" },
    });
  }

  const [inserted] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_optin_windows (
      school_id, license_id, academic_year_id, opens_on, closes_on, note, opened_by
    ) VALUES (
      ${schoolId}::uuid, ${license.id}::uuid, ${year.id}::uuid, ${input.opensOn}::date,
      ${input.closesOn}::date, ${input.note?.trim() || null}, ${actor.userId}::uuid
    )
    RETURNING id::text AS id
  `;
  const windowId = inserted!.id;
  for (const gradeLevelId of gradeLevelIds) {
    await tx`
      INSERT INTO app.ai_optin_window_scopes (school_id, window_id, grade_level_id)
      VALUES (${schoolId}::uuid, ${windowId}::uuid, ${gradeLevelId}::uuid)
    `;
  }
  for (const sectionId of sectionIds) {
    await tx`
      INSERT INTO app.ai_optin_window_scopes (school_id, window_id, section_id)
      VALUES (${schoolId}::uuid, ${windowId}::uuid, ${sectionId}::uuid)
    `;
  }
  await auditLicenseChange(tx, schoolId, actor, {
    action: "insert",
    targetTable: "ai_optin_windows",
    targetId: windowId,
    newValues: {
      license_id: license.id,
      academic_year_id: year.id,
      opens_on: input.opensOn,
      closes_on: input.closesOn,
      grade_level_ids: gradeLevelIds,
      section_ids: sectionIds,
    },
  });
  return toWindowView(tx, (await windowRow(tx, windowId))!, today);
}

export async function closeWindow(
  tx: TransactionSql,
  schoolId: string,
  windowId: string,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<AiOptInWindowView> {
  const row = await windowRow(tx, windowId, { forUpdate: true });
  if (!row || row.closed_at) {
    throw licenseError(404, ERROR_CODES.AI_OPTIN_WINDOW_NOT_FOUND, actor.locale);
  }
  await tx`
    UPDATE app.ai_optin_windows
    SET closed_at = CURRENT_TIMESTAMP, closed_by = ${actor.userId}::uuid,
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${windowId}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "ai_optin_windows",
    targetId: windowId,
    oldValues: { closed_at: null },
    newValues: { closed_by: actor.userId },
  });
  return toWindowView(tx, (await windowRow(tx, windowId))!, await schoolToday(tx, now));
}

// ---------------------------------------------------------------------------------------------------
// Recording opt-ins (parent or school)
// ---------------------------------------------------------------------------------------------------

export type NotRecordedReason = "not_eligible" | "already_opted_in" | "not_found";

export interface RecordResult {
  recorded: AiOptInView[];
  notRecorded: { studentId: string | null; reference: string; reason: NotRecordedReason }[];
}

interface OptInContext {
  window: WindowRow;
  license: LicenseRecord;
  programme: OptInProgramme & { monthlyPriceMinor: number };
  period: { startMonth: string; endMonth: string; months: number };
  today: string;
}

/** The open window and what an opt-in through it today costs; refused when there is none. */
async function optInContext(
  tx: TransactionSql,
  actor: LicenseActor,
  now: Date,
): Promise<OptInContext> {
  const today = await schoolToday(tx, now);
  const window = await openWindowRow(tx, today);
  if (!window) throw licenseError(409, ERROR_CODES.AI_OPTIN_WINDOW_CLOSED, actor.locale);
  const license = await readLicense(tx, window.license_id, { forUpdate: true });
  if (!license || !OPEN_FOR_OPT_IN.has(license.status)) {
    throw licenseError(409, ERROR_CODES.AI_OPTIN_WINDOW_CLOSED, actor.locale);
  }
  const programme = await optInProgramme(tx, license);
  if (programme.monthlyPriceMinor === null) {
    throw licenseError(409, ERROR_CODES.AI_OPTIN_PRICE_MISSING, actor.locale);
  }
  const period = aiOptInPeriod({ startsOn: window.ay_starts_on, endsOn: window.ay_ends_on }, today);
  if (!period) throw licenseError(409, ERROR_CODES.AI_OPTIN_YEAR_OVER, actor.locale);
  return {
    window,
    license,
    programme: { ...programme, monthlyPriceMinor: programme.monthlyPriceMinor },
    period,
    today,
  };
}

/** Tell the child's linked parents that Student AI is confirmed (in-app and push). */
async function notifyConfirmed(
  tx: TransactionSql,
  schoolId: string,
  optIn: AiOptInView,
): Promise<void> {
  const parents = await tx<{ parent_user_id: string }[]>`
    SELECT DISTINCT pcl.parent_user_id::text AS parent_user_id
    FROM app.parent_child_links AS pcl
    JOIN app.users AS u ON u.id = pcl.parent_user_id AND u.school_id = pcl.school_id
    WHERE pcl.school_id = current_setting('app.school_id')::uuid
      AND pcl.student_id = ${optIn.studentId}::uuid
      AND u.status IN ('invited', 'active')
  `;
  if (parents.length === 0) return;
  const [school] = await tx<{ name: string }[]>`
    SELECT name FROM app.schools WHERE id = ${schoolId}::uuid
  `;
  const locale = await schoolLocale(tx);
  const type = NOTIFICATION_TYPES.AI_OPTIN_CONFIRMED;
  // Parent-facing: never the price or the total (the school tells parents the price).
  const vars = {
    childName: optIn.studentName,
    schoolName: school?.name ?? "",
    startMonth: optIn.startMonth.slice(0, 7),
  };
  for (const parent of parents) {
    await tx`
      INSERT INTO app.notifications (id, school_id, user_id, notification_type, title, body, metadata)
      VALUES (
        ${crypto.randomUUID()}::uuid, ${schoolId}::uuid, ${parent.parent_user_id}::uuid,
        ${type}::app.notification_type,
        ${renderNotification(type, NOTIFICATION_CHANNELS.PUSH, locale, vars).trim()},
        ${renderNotification(type, NOTIFICATION_CHANNELS.IN_APP, locale, vars).trim()},
        ${tx.json({ route: "/parent/student-ai", student_id: optIn.studentId, opt_in_id: optIn.id })}
      )
    `;
  }
}

async function insertOptIn(
  tx: TransactionSql,
  schoolId: string,
  ctx: Pick<OptInContext, "license" | "programme" | "period"> & {
    academicYearId: string;
    windowId: string | null;
  },
  row: {
    studentId: string;
    source: AiOptInSource;
    parentUserId: string | null;
    note: string | null;
    transferredFromId?: string | null;
  },
  actor: LicenseActor,
): Promise<AiOptInView> {
  const total = aiOptInTotal(ctx.programme.monthlyPriceMinor, ctx.period.months);
  const [inserted] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_optins (
      school_id, student_id, academic_year_id, license_id, window_id, source, parent_user_id,
      recorded_by, note, terms_version, start_month, end_month, months, currency_id,
      monthly_price_minor, total_minor, transferred_from_id
    ) VALUES (
      ${schoolId}::uuid, ${row.studentId}::uuid, ${ctx.academicYearId}::uuid, ${ctx.license.id}::uuid,
      ${ctx.windowId}::uuid, ${row.source}, ${row.parentUserId}::uuid, ${actor.userId}::uuid,
      ${row.note}, ${AI_OPTIN_TERMS_VERSION}, ${ctx.period.startMonth}::date,
      ${ctx.period.endMonth}::date, ${ctx.period.months}, ${ctx.programme.currencyId}::uuid,
      ${ctx.programme.monthlyPriceMinor}, ${total}, ${row.transferredFromId ?? null}::uuid
    )
    RETURNING id::text AS id
  `;
  const view = (await readOptIn(tx, inserted!.id))!;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "insert",
    targetTable: "ai_optins",
    targetId: view.id,
    newValues: {
      student_id: view.studentId,
      academic_year_id: view.academicYearId,
      license_id: view.licenseId,
      window_id: view.windowId,
      source: view.source,
      parent_user_id: view.parent?.userId ?? null,
      note: view.note,
      terms_version: view.termsVersion,
      start_month: view.startMonth,
      months: view.months,
      monthly_price_minor: view.monthlyPriceMinor,
      total_minor: view.totalMinor,
      transferred_from_id: view.transferredFromId,
    },
  });
  return view;
}

/** Of `studentIds`, who the open window lets opt in and who already has. */
async function eligibility(
  tx: TransactionSql,
  window: WindowRow,
  studentIds: readonly string[],
): Promise<Map<string, { eligible: boolean; optedIn: boolean }>> {
  const rows = await tx<{ id: string; eligible: boolean; opted_in: boolean }[]>`
    SELECT s.id::text AS id,
           (${eligibleIn(tx, window.id, window.academic_year_id)}) AS eligible,
           EXISTS (
             SELECT 1 FROM app.ai_optins AS o
             WHERE o.school_id = s.school_id AND o.student_id = s.id
               AND o.academic_year_id = ${window.academic_year_id}::uuid AND o.status = 'active'
           ) AS opted_in
    FROM app.students AS s
    WHERE s.school_id = current_setting('app.school_id')::uuid AND s.id = ANY(${[...studentIds]}::uuid[])
  `;
  return new Map(rows.map((r) => [r.id, { eligible: r.eligible, optedIn: r.opted_in }]));
}

/** After opt-ins are written: seat them, size the seat request, tell the parents. */
async function afterOptIns(
  tx: TransactionSql,
  schoolId: string,
  ctx: Pick<OptInContext, "license" | "programme">,
  recorded: AiOptInView[],
  actor: LicenseActor,
  now: Date,
): Promise<Changed<AiOptInView[]>> {
  const filled = await fillWaitingOptInSeats(tx, schoolId, ctx.license.id, actor, now);
  const views: AiOptInView[] = [];
  for (const optIn of recorded) {
    const view = (await readOptIn(tx, optIn.id))!;
    await notifyConfirmed(tx, schoolId, view);
    views.push(view);
  }
  return { result: views, versions: filled.versions, pending: filled.pending };
}

export interface ParentOptInInput {
  studentId: string;
  acceptTerms: boolean;
  /** The terms the parent read; refused (409 AI_OPTIN_TERMS_CHANGED) unless the current ones. */
  termsVersion: string;
}

/**
 * A parent opts their own child in. They must be linked to the child, the window must be open and
 * include the child, and the current terms accepted. The parent is never shown a price (the school
 * tells them), so none is echoed back; the price in force is snapshotted on the opt-in for billing.
 * Recorded with who, when and the terms version; it cannot be undone.
 */
export async function parentOptIn(
  tx: TransactionSql,
  schoolId: string,
  input: ParentOptInInput,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<Changed<AiOptInView>> {
  if (!input.acceptTerms) {
    throw licenseError(422, ERROR_CODES.AI_OPTIN_TERMS_REQUIRED, actor.locale);
  }
  if (input.termsVersion !== AI_OPTIN_TERMS_VERSION) {
    throw licenseError(409, ERROR_CODES.AI_OPTIN_TERMS_CHANGED, actor.locale);
  }
  const [linked] = await tx<{ ok: boolean }[]>`
    SELECT true AS ok FROM app.parent_child_links
    WHERE school_id = current_setting('app.school_id')::uuid
      AND parent_user_id = ${actor.userId}::uuid AND student_id = ${input.studentId}::uuid
  `;
  if (!linked) throw licenseError(422, ERROR_CODES.AI_OPTIN_NOT_ELIGIBLE, actor.locale);
  const ctx = await optInContext(tx, actor, now);
  const state = (await eligibility(tx, ctx.window, [input.studentId])).get(input.studentId);
  if (state?.optedIn) throw licenseError(409, ERROR_CODES.AI_OPTIN_ALREADY_OPTED_IN, actor.locale);
  if (!state?.eligible) throw licenseError(422, ERROR_CODES.AI_OPTIN_NOT_ELIGIBLE, actor.locale);
  const optIn = await insertOptIn(
    tx,
    schoolId,
    { ...ctx, academicYearId: ctx.window.academic_year_id, windowId: ctx.window.id },
    { studentId: input.studentId, source: "parent", parentUserId: actor.userId, note: null },
    actor,
  );
  const after = await afterOptIns(tx, schoolId, ctx, [optIn], actor, now);
  return { ...after, result: after.result[0]! };
}

export interface SchoolRecordInput {
  studentIds?: string[];
  /** School-issued admission numbers (e.g. from a CSV); never a government ID. */
  admissionNumbers?: string[];
  note: string;
}

/**
 * The school records opt-ins on parents' behalf (a paper form, a phone call): one, many, or a CSV of
 * admission numbers, with a note. Same window, eligibility and price as a parent's; each is
 * reported recorded or not, and why.
 */
export async function recordOnBehalf(
  tx: TransactionSql,
  schoolId: string,
  input: SchoolRecordInput,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<Changed<RecordResult>> {
  const ctx = await optInContext(tx, actor, now);
  const result: RecordResult = { recorded: [], notRecorded: [] };

  const ids = new Set(input.studentIds ?? []);
  const numbers = [...new Set((input.admissionNumbers ?? []).map((n) => n.trim()).filter(Boolean))];
  if (numbers.length > 0) {
    const found = await tx<{ id: string; number: string }[]>`
      SELECT id::text AS id, normalized_admission_number AS number FROM app.students
      WHERE school_id = current_setting('app.school_id')::uuid
        AND normalized_admission_number = ANY(${numbers.map((n) => n.toLowerCase())}::text[])
    `;
    const byNumber = new Map(found.map((row) => [row.number, row.id]));
    for (const number of numbers) {
      const id = byNumber.get(number.toLowerCase());
      if (id) ids.add(id);
      else result.notRecorded.push({ studentId: null, reference: number, reason: "not_found" });
    }
  }
  const studentIds = [...ids];
  const states = await eligibility(tx, ctx.window, studentIds);
  const toRecord: string[] = [];
  for (const studentId of studentIds) {
    const state = states.get(studentId);
    if (!state) result.notRecorded.push({ studentId, reference: studentId, reason: "not_found" });
    else if (state.optedIn) {
      result.notRecorded.push({ studentId, reference: studentId, reason: "already_opted_in" });
    } else if (!state.eligible) {
      result.notRecorded.push({ studentId, reference: studentId, reason: "not_eligible" });
    } else toRecord.push(studentId);
  }

  const recorded: AiOptInView[] = [];
  for (const studentId of toRecord) {
    recorded.push(
      await insertOptIn(
        tx,
        schoolId,
        { ...ctx, academicYearId: ctx.window.academic_year_id, windowId: ctx.window.id },
        {
          studentId,
          source: "school_on_behalf",
          parentUserId: null,
          note: input.note.trim(),
        },
        actor,
      ),
    );
  }
  if (recorded.length === 0) return { result, ...NO_CHANGE };
  const after = await afterOptIns(tx, schoolId, ctx, recorded, actor, now);
  result.recorded = after.result;
  return { result, versions: after.versions, pending: after.pending };
}

// ---------------------------------------------------------------------------------------------------
// A student leaves: transfer or release
// ---------------------------------------------------------------------------------------------------

async function requireLeftStudentOptIn(
  tx: TransactionSql,
  optInId: string,
  actor: LicenseActor,
): Promise<AiOptInView> {
  const optIn = await readOptIn(tx, optInId, { forUpdate: true });
  if (!optIn) throw licenseError(404, ERROR_CODES.AI_OPTIN_NOT_FOUND, actor.locale);
  if (optIn.status !== "active") throw licenseError(409, ERROR_CODES.AI_OPTIN_ENDED, actor.locale);
  const [student] = await tx<{ left: boolean }[]>`
    SELECT status::text = ANY(${[...LEFT_STATUSES]}::text[]) AS left
    FROM app.students
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${optIn.studentId}::uuid
  `;
  if (!student?.left) {
    throw licenseError(409, ERROR_CODES.AI_OPTIN_STUDENT_NOT_LEFT, actor.locale);
  }
  return optIn;
}

/** Free the seat an ended opt-in held (the programme lock lifts once it is no longer active). */
async function freeSeat(
  tx: TransactionSql,
  schoolId: string,
  optIn: AiOptInView,
  actor: LicenseActor,
): Promise<Map<string, number>> {
  if (!optIn.seatId) return new Map();
  const [seat] = await tx<{ user_id: string }[]>`
    UPDATE app.license_seats
    SET unassigned_at = CURRENT_TIMESTAMP, unassigned_by = ${actor.userId}::uuid,
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${optIn.seatId}::uuid
      AND unassigned_at IS NULL
    RETURNING user_id::text AS user_id
  `;
  if (!seat) return new Map();
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "license_seats",
    targetId: optIn.seatId,
    oldValues: { unassigned_at: null },
    newValues: { unassigned_by: actor.userId, reason: `ai_optin ${optIn.status}` },
  });
  return publishUserEntitlementChanges(tx, { schoolId, userIds: [seat.user_id] });
}

/**
 * The student left: release the seat. It is no longer charged from the next month (school-local);
 * the seat frees now and goes to the next opt-in waiting for one, if any.
 */
export async function releaseOptIn(
  tx: TransactionSql,
  schoolId: string,
  optInId: string,
  input: { note: string },
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<Changed<AiOptInView>> {
  await requireLeftStudentOptIn(tx, optInId, actor);
  const effective = firstOfNextMonth(await schoolToday(tx, now));
  await tx`
    UPDATE app.ai_optins
    SET status = 'released', ended_at = CURRENT_TIMESTAMP, ended_by = ${actor.userId}::uuid,
        end_note = ${input.note.trim()}, released_effective_month = ${effective}::date,
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${optInId}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "ai_optins",
    targetId: optInId,
    oldValues: { status: "active" },
    newValues: { status: "released", released_effective_month: effective, note: input.note.trim() },
  });
  const released = (await readOptIn(tx, optInId))!;
  const versions = await freeSeat(tx, schoolId, released, actor);
  const filled = await fillWaitingOptInSeats(tx, schoolId, released.licenseId, actor, now);
  for (const [userId, version] of filled.versions) versions.set(userId, version);
  return { result: released, versions, pending: filled.pending };
}

/**
 * The student left: their seat goes to another student for the rest of the year, with no billing
 * change. The other student must be enrolled and not opted in this year; they get an opt-in of
 * source 'transfer' holding a seat on the licence, charged from the next month to the year's end
 * (the leaving student is charged through this month).
 */
export async function transferOptIn(
  tx: TransactionSql,
  schoolId: string,
  optInId: string,
  input: { toStudentId: string; note: string },
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<Changed<{ from: AiOptInView; to: AiOptInView }>> {
  const from = await requireLeftStudentOptIn(tx, optInId, actor);
  const [target] = await tx<{ enrolled: boolean; opted_in: boolean }[]>`
    SELECT s.status = 'enrolled' AS enrolled,
           EXISTS (
             SELECT 1 FROM app.ai_optins AS o
             WHERE o.school_id = s.school_id AND o.student_id = s.id
               AND o.academic_year_id = ${from.academicYearId}::uuid AND o.status = 'active'
           ) AS opted_in
    FROM app.students AS s
    WHERE s.school_id = current_setting('app.school_id')::uuid AND s.id = ${input.toStudentId}::uuid
  `;
  if (!target || !target.enrolled) {
    throw licenseError(422, ERROR_CODES.AI_OPTIN_NOT_ELIGIBLE, actor.locale);
  }
  if (target.opted_in) throw licenseError(409, ERROR_CODES.AI_OPTIN_ALREADY_OPTED_IN, actor.locale);

  const license = (await readLicense(tx, from.licenseId, { forUpdate: true }))!;
  const [year] = await tx<{ starts_on: string; ends_on: string }[]>`
    SELECT starts_on::text AS starts_on, ends_on::text AS ends_on FROM app.academic_years
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${from.academicYearId}::uuid
  `;
  // The leaving student is charged through this month (as a release stops from the next), so the
  // new holder's months start the month after: no month is charged twice.
  const period = aiOptInPeriod(
    { startsOn: year!.starts_on, endsOn: year!.ends_on },
    firstOfNextMonth(await schoolToday(tx, now)),
  );
  if (!period) throw licenseError(409, ERROR_CODES.AI_OPTIN_YEAR_OVER, actor.locale);
  const programme = await optInProgramme(tx, license);
  const note = input.note.trim();

  // The seat's new holder: the same monthly price, for the months left.
  const to = await insertOptIn(
    tx,
    schoolId,
    {
      license,
      programme: { ...programme, monthlyPriceMinor: from.monthlyPriceMinor },
      period,
      academicYearId: from.academicYearId,
      windowId: from.windowId,
    },
    {
      studentId: input.toStudentId,
      source: "transfer",
      parentUserId: null,
      note,
      transferredFromId: from.id,
    },
    actor,
  );
  await tx`
    UPDATE app.ai_optins
    SET status = 'transferred', ended_at = CURRENT_TIMESTAMP, ended_by = ${actor.userId}::uuid,
        end_note = ${note}, transferred_to_id = ${to.id}::uuid,
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${from.id}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "ai_optins",
    targetId: from.id,
    oldValues: { status: "active" },
    newValues: { status: "transferred", transferred_to_id: to.id, note },
  });
  const ended = (await readOptIn(tx, from.id))!;
  const versions = await freeSeat(tx, schoolId, ended, actor);
  const filled = await fillWaitingOptInSeats(tx, schoolId, license.id, actor, now);
  for (const [userId, version] of filled.versions) versions.set(userId, version);
  return {
    result: { from: ended, to: (await readOptIn(tx, to.id))! },
    versions,
    pending: filled.pending,
  };
}

// ---------------------------------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------------------------------

export interface AiOptInStudentRow {
  studentId: string;
  name: string;
  admissionNumber: string;
  studentStatus: string;
  gradeLevelName: string | null;
  sectionName: string | null;
  /** Whether the latest window lets them opt in (enrolled, in its grades/sections). */
  eligible: boolean;
  /** Their opt-in this academic year (active, else the latest ended one). */
  optIn: AiOptInView | null;
}

/**
 * The school's students for the latest window's academic year (or the current one), with their
 * opt-in: who opted in, who waits for a seat, who has not, and who left holding a seat.
 */
export async function listOptInStudents(
  tx: TransactionSql,
  input: {
    filter: "all" | "opted_in" | "not_opted_in" | "waiting" | "left_with_seat";
    gradeLevelId?: string;
    sectionId?: string;
    search?: string;
    limit: number;
    offset: number;
  },
  now: Date = new Date(),
): Promise<{ students: AiOptInStudentRow[]; total: number }> {
  const today = await schoolToday(tx, now);
  const latest = await latestWindowRow(tx);
  const year = latest ? { id: latest.academic_year_id } : await currentAcademicYear(tx, today);
  if (!year) return { students: [], total: 0 };
  const pattern = input.search?.trim() ? likeContains(input.search.trim()) : null;
  const rows = await tx<
    {
      student_id: string;
      name: string;
      admission_number: string;
      student_status: string;
      grade_level_name: string | null;
      section_name: string | null;
      eligible: boolean;
      opt_in_id: string | null;
      total: string;
    }[]
  >`
    WITH base AS (
      SELECT s.id, COALESCE(NULLIF(btrim(concat_ws(' ', s.first_name, s.last_name)), ''), 'Student') AS name,
             s.admission_number, s.status::text AS student_status,
             g.name AS grade_level_name, sec.name AS section_name, sec.id AS section_id,
             sec.grade_level_id,
             ${latest ? tx`(${eligibleIn(tx, latest.id, latest.academic_year_id)})` : tx`s.status = 'enrolled'`} AS eligible,
             (SELECT o.id FROM app.ai_optins AS o
              WHERE o.school_id = s.school_id AND o.student_id = s.id
                AND o.academic_year_id = ${year.id}::uuid
              ORDER BY o.status = 'active' DESC, o.opted_in_at DESC LIMIT 1) AS opt_in_id
      FROM app.students AS s
      LEFT JOIN app.student_sections AS ss
        ON ss.school_id = s.school_id AND ss.student_id = s.id AND ss.academic_year_id = ${year.id}::uuid
      LEFT JOIN app.sections AS sec ON sec.id = ss.section_id AND sec.school_id = ss.school_id
      LEFT JOIN app.grade_levels AS g ON g.id = sec.grade_level_id AND g.school_id = sec.school_id
      WHERE s.school_id = current_setting('app.school_id')::uuid
        AND (s.status = 'enrolled' OR EXISTS (
          SELECT 1 FROM app.ai_optins AS o
          WHERE o.school_id = s.school_id AND o.student_id = s.id
            AND o.academic_year_id = ${year.id}::uuid
        ))
        ${pattern ? tx`AND (concat_ws(' ', s.first_name, s.last_name) ILIKE ${pattern} OR s.admission_number ILIKE ${pattern})` : tx``}
        ${input.gradeLevelId ? tx`AND sec.grade_level_id = ${input.gradeLevelId}::uuid` : tx``}
        ${input.sectionId ? tx`AND sec.id = ${input.sectionId}::uuid` : tx``}
    ),
    marked AS (
      SELECT b.*, o.status AS opt_status, o.seat_id AS opt_seat
      FROM base AS b
      LEFT JOIN app.ai_optins AS o
        ON o.school_id = current_setting('app.school_id')::uuid AND o.id = b.opt_in_id
    )
    SELECT id::text AS student_id, name, admission_number, student_status, grade_level_name,
           section_name, eligible, opt_in_id::text AS opt_in_id, count(*) OVER ()::text AS total
    FROM marked
    WHERE true
      ${input.filter === "opted_in" ? tx`AND opt_status = 'active'` : tx``}
      ${input.filter === "not_opted_in" ? tx`AND (opt_status IS NULL OR opt_status <> 'active') AND student_status = 'enrolled'` : tx``}
      ${input.filter === "waiting" ? tx`AND opt_status = 'active' AND opt_seat IS NULL` : tx``}
      ${input.filter === "left_with_seat" ? tx`AND opt_status = 'active' AND student_status = ANY(${[...LEFT_STATUSES]}::text[])` : tx``}
    ORDER BY lower(name), admission_number
    LIMIT ${input.limit} OFFSET ${input.offset}
  `;
  const optInIds = rows.map((r) => r.opt_in_id).filter((id): id is string => id !== null);
  const optIns =
    optInIds.length === 0
      ? []
      : (
          await tx<OptInRow[]>`
            SELECT ${OPT_IN_COLUMNS(tx)} ${OPT_IN_FROM(tx)}
            WHERE o.school_id = current_setting('app.school_id')::uuid
              AND o.id = ANY(${optInIds}::uuid[])
          `
        ).map(toOptInView);
  return {
    students: rows.map((row) => ({
      studentId: row.student_id,
      name: row.name,
      admissionNumber: row.admission_number,
      studentStatus: row.student_status,
      gradeLevelName: row.grade_level_name,
      sectionName: row.section_name,
      eligible: row.eligible,
      optIn: optIns.find((o) => o.id === row.opt_in_id) ?? null,
    })),
    total: Number(rows[0]?.total ?? 0),
  };
}

// ---------------------------------------------------------------------------------------------------
// The parent's view
// ---------------------------------------------------------------------------------------------------

/**
 * A child's opt-in as the parent sees it: who recorded it, when, the months it covers and where it
 * stands. Never the price, the total or the currency: the school tells parents the price (owner,
 * 2026-11-18), so no parent-callable read carries it. The price is still snapshotted on the opt-in
 * row for billing.
 */
export interface ParentAiOptInView {
  id: string;
  studentId: string;
  studentName: string;
  source: AiOptInSource;
  termsVersion: string;
  optedInAt: string;
  startMonth: string;
  endMonth: string;
  status: AiOptInStatus;
  /** Active, but the school's licence has no place for the child yet: Student AI starts once it does. */
  waitingForSchool: boolean;
  releasedEffectiveMonth: string | null;
}

export function toParentOptInView(view: AiOptInView): ParentAiOptInView {
  return {
    id: view.id,
    studentId: view.studentId,
    studentName: view.studentName,
    source: view.source,
    termsVersion: view.termsVersion,
    optedInAt: view.optedInAt,
    startMonth: view.startMonth,
    endMonth: view.endMonth,
    status: view.status,
    waitingForSchool: view.status === "active" && view.seatId === null,
    releasedEffectiveMonth: view.releasedEffectiveMonth,
  };
}

export interface ParentAiOffer {
  studentId: string;
  studentName: string;
  /**
   * available: the window is open for this child; opted_in: they have it this year (or it ended,
   * see optIn.status); closed: the school's window for this year is closed or not open yet.
   */
  state: "available" | "opted_in" | "closed";
  window: { id: string; opensOn: string; closesOn: string; academicYearName: string } | null;
  /** The months joining today would cover (available only). No price: the school tells parents. */
  period: { startMonth: string; endMonth: string } | null;
  optIn: ParentAiOptInView | null;
}

export interface ParentAiOffers {
  /** The school offering it (this account's school). */
  schoolName: string;
  offers: ParentAiOffer[];
  termsVersion: string;
}

/**
 * What a parent sees, per linked child at this school (each school's account shows its own): the
 * Student AI offer while a window is open for the child, the opt-in once there is one, or that the
 * school's window is closed. Children the school never offered it to are left out.
 */
export async function parentOffers(
  tx: TransactionSql,
  parentUserId: string,
  now: Date = new Date(),
): Promise<ParentAiOffers> {
  const today = await schoolToday(tx, now);
  const latest = await latestWindowRow(tx);
  const [school] = await tx<{ name: string }[]>`
    SELECT name FROM app.schools WHERE id = current_setting('app.school_id')::uuid
  `;
  const schoolName = school?.name ?? "";
  const children = await tx<{ id: string; name: string }[]>`
    SELECT s.id::text AS id,
           COALESCE(NULLIF(btrim(concat_ws(' ', s.first_name, s.last_name)), ''), 'Student') AS name
    FROM app.parent_child_links AS pcl
    JOIN app.students AS s ON s.id = pcl.student_id AND s.school_id = pcl.school_id
    WHERE pcl.school_id = current_setting('app.school_id')::uuid
      AND pcl.parent_user_id = ${parentUserId}::uuid
    ORDER BY lower(s.first_name), s.id
  `;
  if (children.length === 0)
    return { schoolName, offers: [], termsVersion: AI_OPTIN_TERMS_VERSION };

  const ids = children.map((c) => c.id);
  const optIns = (
    await tx<OptInRow[]>`
      SELECT ${OPT_IN_COLUMNS(tx)} ${OPT_IN_FROM(tx)}
      WHERE o.school_id = current_setting('app.school_id')::uuid
        AND o.student_id = ANY(${ids}::uuid[])
        ${latest ? tx`AND o.academic_year_id = ${latest.academic_year_id}::uuid` : tx``}
      ORDER BY o.status = 'active' DESC, o.opted_in_at DESC
    `
  ).map((row) => toParentOptInView(toOptInView(row)));

  const open = latest && windowState(latest, today) === "open" ? latest : null;
  const states = latest
    ? await eligibility(tx, latest, ids)
    : new Map<string, { eligible: boolean; optedIn: boolean }>();
  // Open to join only when the licence takes opt-ins and the programme prices it for the school
  // (checked here, never sent: the parent is not shown the price).
  let period: ParentAiOffer["period"] = null;
  if (open) {
    const license = await readLicense(tx, open.license_id);
    const programme =
      license && OPEN_FOR_OPT_IN.has(license.status) ? await optInProgramme(tx, license) : null;
    const months = aiOptInPeriod({ startsOn: open.ay_starts_on, endsOn: open.ay_ends_on }, today);
    if (programme?.monthlyPriceMinor != null && months) {
      period = { startMonth: months.startMonth, endMonth: months.endMonth };
    }
  }

  const offers: ParentAiOffer[] = [];
  for (const child of children) {
    const optIn = optIns.find((o) => o.studentId === child.id) ?? null;
    const windowRef = latest
      ? {
          id: latest.id,
          opensOn: latest.opens_on,
          closesOn: latest.closes_on,
          academicYearName: latest.academic_year_name,
        }
      : null;
    if (optIn) {
      offers.push({
        studentId: child.id,
        studentName: child.name,
        state: "opted_in",
        window: windowRef,
        period: null,
        optIn,
      });
      continue;
    }
    const eligible = states.get(child.id)?.eligible ?? false;
    if (!latest || !eligible) continue;
    offers.push({
      studentId: child.id,
      studentName: child.name,
      state: open && period ? "available" : "closed",
      window: windowRef,
      period: open ? period : null,
      optIn: null,
    });
  }
  return { schoolName, offers, termsVersion: AI_OPTIN_TERMS_VERSION };
}
