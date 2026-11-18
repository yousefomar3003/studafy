import { computeUploadConsistency } from "@studafy/license-pricing";

import type { TransactionSql } from "postgres";

/**
 * Upload consistency for the Student AI programme's content bonus (phase 4; decision 10 of the
 * plan; docs/billing/ai-upload-consistency.md): the share of school days on which a class's teachers
 * published a lesson or material, per class, per teacher and averaged for the school, over any
 * [from, to].
 *
 * The ONE database read of it, shared by the API (the school's and the super admin's views) and the
 * revenue share engine (`uploadConsistencyForPeriod` in ./measures.ts, run by the API on a payment
 * and by the workers' hourly job), so a bonus is measured the same way wherever it is worked out.
 *
 * Every function here reads the armed school (`app.school_id`) and works under either role: as
 * studafy_app for a school admin or principal (who see every class, 000120, and every opt-in,
 * 000235), or as studafy_admin scoped to the school for the super admin and the workers. Nothing is
 * written. The counting itself is pure (`computeUploadConsistency` in @studafy/license-pricing).
 */

/** app.school_settings defaults (000039, 000122), for a school whose settings row was never created. */
const DEFAULT_TIMEZONE = "Africa/Casablanca";
const DEFAULT_SCHOOL_WEEKDAYS = [7, 1, 2, 3, 4];

/** A measured period: calendar days in the school's timezone, inclusive. */
export interface UploadPeriod {
  from: string;
  to: string;
}

export interface SchoolCalendar {
  timezone: string;
  weekdays: number[];
  /** Today in the school's timezone. */
  today: string;
}

/** The armed school's timezone, teaching weekdays and today's date there. */
export async function schoolCalendar(tx: TransactionSql): Promise<SchoolCalendar> {
  const [row] = await tx<{ timezone: string; weekdays: number[]; today: string }[]>`
    WITH settings AS (
      SELECT COALESCE(st.timezone, ${DEFAULT_TIMEZONE}) AS timezone,
             COALESCE(st.school_days::int[], ${DEFAULT_SCHOOL_WEEKDAYS}::int[]) AS weekdays
      FROM (SELECT current_setting('app.school_id')::uuid AS id) AS school
      LEFT JOIN app.school_settings AS st ON st.school_id = school.id
    )
    SELECT timezone, weekdays,
           (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date::text AS today
    FROM settings
  `;
  return { timezone: row!.timezone, weekdays: row!.weekdays, today: row!.today };
}

/** The first instant of `day` in `timezone`. */
const startOfDay = (tx: TransactionSql, day: string, timezone: string) =>
  tx`(${day}::date::timestamp AT TIME ZONE ${timezone})`;

/** The first instant after `day` in `timezone`. */
const endOfDay = (tx: TransactionSql, day: string, timezone: string) =>
  tx`((${day}::date + 1)::timestamp AT TIME ZONE ${timezone})`;

/**
 * THE rule for which classes are measured: the classes that have Student AI in the period -- a
 * class with at least one student who, at some point in the period,
 *
 *   * was in the class (enrolment active or completed, or withdrawn during or after the period), and
 *   * held a Student AI programme opt-in (000235) whose months overlap the period (from its start
 *     month to its last month, or to the month before a release takes effect) and that held its
 *     licence seat in the period (linked to a seat assigned before the period ended and not
 *     unassigned before it started -- an opt-in still waiting for a seat does not count), and
 *   * on a licence of the school whose dates overlap the period and that was taken up (not a draft,
 *     not cancelled) -- not necessarily activated yet: a licence's first payment is what activates
 *     it, and the share on that payment measures the very period it pays for.
 *
 * Change the rule here and every reader -- the school's and the super admin's views, and the revenue
 * share engine -- follows. Returns a subquery of class ids for the armed school.
 */
export function studentAiClassIds(tx: TransactionSql, period: UploadPeriod, timezone: string) {
  const startsAt = startOfDay(tx, period.from, timezone);
  const endsAt = endOfDay(tx, period.to, timezone);
  return tx`
    SELECT DISTINCT e.class_id
    FROM app.enrollments AS e
    JOIN app.ai_optins AS o ON o.school_id = e.school_id AND o.student_id = e.student_id
    JOIN app.license_seats AS seat ON seat.id = o.seat_id AND seat.school_id = o.school_id
    JOIN app.school_licenses AS l ON l.id = o.license_id AND l.school_id = o.school_id
    WHERE e.school_id = current_setting('app.school_id')::uuid
      AND (e.status IN ('active', 'completed')
           OR (e.status = 'withdrawn' AND e.withdrawn_at >= ${startsAt}))
      AND o.start_month <= ${period.to}::date
      AND (o.end_month + interval '1 month')::date > ${period.from}::date
      AND (o.released_effective_month IS NULL OR o.released_effective_month > ${period.from}::date)
      AND seat.assigned_at < ${endsAt}
      AND (seat.unassigned_at IS NULL OR seat.unassigned_at >= ${startsAt})
      AND l.status NOT IN ('draft', 'cancelled')
      AND l.starts_at < ${endsAt}
      AND l.ends_at > ${startsAt}
  `;
}

export interface UploadConsistencyClassView {
  classId: string;
  code: string;
  courseName: string;
  sectionId: string | null;
  /** School days in the period that fall in the class's term, up to today. */
  schoolDays: number;
  /** Of those, the days a lesson or material for the class was published on. */
  uploadDays: number;
  /** Basis points, rounded down; null when the class had no school day in the period. */
  consistencyBps: number | null;
  teacherIds: string[];
}

export interface UploadConsistencyTeacherView {
  teacherId: string;
  userId: string;
  name: string;
  /** The measured classes the teacher teaches (lead teacher, or on the approved timetable). */
  classIds: string[];
  /** Mean of those classes' basis points, rounded down; null when none had a school day. */
  consistencyBps: number | null;
}

export interface UploadConsistencyReport {
  timezone: string;
  /** Today in the school's timezone. */
  today: string;
  from: string;
  to: string;
  /** The last day counted: `to`, or today when `to` is later. */
  countedTo: string;
  /** School days in [from, countedTo]: teaching weekdays that are not calendar holidays. */
  schoolDays: number;
  /** Classes with a school day in the period: the ones the school's average is over. */
  classesCounted: number;
  /** The school's upload consistency, basis points rounded down; null when no class counts. */
  consistencyBps: number | null;
  classes: UploadConsistencyClassView[];
  teachers: UploadConsistencyTeacherView[];
}

interface ClassRow {
  id: string;
  code: string;
  course_name: string;
  section_id: string | null;
  term_starts_on: string;
  term_ends_on: string;
}

/**
 * The armed school's upload consistency over [from, to] (school calendar days, inclusive). Days
 * after today in the school's timezone never count. Classes are those `studentAiClassIds` selects
 * whose term overlaps the period; a class counts only the school days of its own term.
 */
export async function uploadConsistency(
  tx: TransactionSql,
  period: UploadPeriod,
): Promise<UploadConsistencyReport> {
  const calendar = await schoolCalendar(tx);
  const { timezone } = calendar;

  const holidays = await tx<{ starts_on: string; ends_on: string }[]>`
    SELECT starts_on::text AS starts_on, ends_on::text AS ends_on
    FROM app.school_events
    WHERE school_id = current_setting('app.school_id')::uuid
      AND kind = 'holiday'
      AND starts_on <= ${period.to}::date
      AND ends_on >= ${period.from}::date
  `;

  const classes = await tx<ClassRow[]>`
    SELECT c.id::text AS id, c.code, co.name AS course_name, c.section_id::text AS section_id,
           t.starts_on::text AS term_starts_on, t.ends_on::text AS term_ends_on
    FROM app.classes AS c
    JOIN app.courses AS co ON co.id = c.course_id AND co.school_id = c.school_id
    JOIN app.terms AS t ON t.id = c.term_id AND t.school_id = c.school_id
    WHERE c.school_id = current_setting('app.school_id')::uuid
      AND c.status <> 'cancelled'
      AND t.starts_on <= ${period.to}::date
      AND t.ends_on >= ${period.from}::date
      AND c.id IN (${studentAiClassIds(tx, period, timezone)})
    ORDER BY co.name, c.code
  `;
  const classIds = classes.map((c) => c.id);

  const teaching =
    classIds.length === 0
      ? []
      : await tx<{ class_id: string; teacher_id: string; user_id: string; name: string }[]>`
          SELECT taught.class_id::text AS class_id, t.id::text AS teacher_id,
                 t.user_id::text AS user_id, COALESCE(u.display_name, u.email) AS name
          FROM (
            SELECT c.id AS class_id, c.lead_teacher_id AS teacher_id
            FROM app.classes AS c
            WHERE c.school_id = current_setting('app.school_id')::uuid
              AND c.id = ANY(${classIds}::uuid[])
            UNION
            SELECT ts.class_id, ts.teacher_id
            FROM app.timetable_slots AS ts
            JOIN app.timetable_versions AS tv
              ON tv.id = ts.timetable_version_id AND tv.school_id = ts.school_id
            WHERE ts.school_id = current_setting('app.school_id')::uuid
              AND ts.class_id = ANY(${classIds}::uuid[])
              AND tv.status = 'approved'
          ) AS taught
          JOIN app.teachers AS t
            ON t.id = taught.teacher_id AND t.school_id = current_setting('app.school_id')::uuid
          JOIN app.users AS u ON u.id = t.user_id AND u.school_id = t.school_id
          ORDER BY name, t.id
        `;

  // Only teachers' class content: students' own and assignment AI sources (000232) never count.
  // idx_materials_school_class_published (000236).
  const countedTo = period.to <= calendar.today ? period.to : calendar.today;
  const uploads =
    classIds.length === 0 || countedTo < period.from
      ? []
      : await tx<{ class_id: string; day: string }[]>`
          SELECT DISTINCT m.class_id::text AS class_id,
                 (m.published_at AT TIME ZONE ${timezone})::date::text AS day
          FROM app.materials AS m
          WHERE m.school_id = current_setting('app.school_id')::uuid
            AND m.source_kind = 'class'
            AND m.class_id = ANY(${classIds}::uuid[])
            AND m.published_at >= ${startOfDay(tx, period.from, timezone)}
            AND m.published_at < ${endOfDay(tx, countedTo, timezone)}
        `;

  const teachersOf = new Map<string, string[]>();
  for (const row of teaching) {
    teachersOf.set(row.class_id, [...(teachersOf.get(row.class_id) ?? []), row.teacher_id]);
  }
  const uploadsOf = new Map<string, string[]>();
  for (const row of uploads) {
    uploadsOf.set(row.class_id, [...(uploadsOf.get(row.class_id) ?? []), row.day]);
  }

  const result = computeUploadConsistency({
    from: period.from,
    to: period.to,
    today: calendar.today,
    schoolWeekdays: calendar.weekdays,
    holidays: holidays.map((h) => ({ startsOn: h.starts_on, endsOn: h.ends_on })),
    classes: classes.map((c) => ({
      classId: c.id,
      term: { startsOn: c.term_starts_on, endsOn: c.term_ends_on },
      uploadDates: uploadsOf.get(c.id) ?? [],
      teacherIds: teachersOf.get(c.id) ?? [],
    })),
  });

  const classById = new Map(classes.map((c) => [c.id, c]));
  const teacherById = new Map(teaching.map((t) => [t.teacher_id, t]));
  return {
    timezone,
    today: calendar.today,
    from: period.from,
    to: period.to,
    countedTo: result.countedTo,
    schoolDays: result.schoolDays,
    classesCounted: result.classesCounted,
    consistencyBps: result.consistencyBps,
    classes: result.classes.map((c) => {
      const row = classById.get(c.classId)!;
      return {
        ...c,
        code: row.code,
        courseName: row.course_name,
        sectionId: row.section_id,
        teacherIds: teachersOf.get(c.classId) ?? [],
      };
    }),
    teachers: result.teachers
      .map((t) => {
        const row = teacherById.get(t.teacherId)!;
        return { ...t, userId: row.user_id, name: row.name };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.teacherId.localeCompare(b.teacherId)),
  };
}
