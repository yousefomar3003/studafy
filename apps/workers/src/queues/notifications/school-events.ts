/**
 * The outbox notify consumer: everyday school events become inbox notifications.
 *
 * Before this, a teacher publishing an assignment, releasing a mark or submitting a register told
 * nobody. The API already emits those facts into `app.outbox_events` in the same transaction as the
 * change (assignment.published, submission.graded, attendance.sessionSubmitted); this consumer reads
 * them per school and writes one `app.notifications` row per person concerned:
 *
 *   - assignment.published       -> ASSIGNMENT_PUBLISHED to the class's active students and their parents
 *   - submission.graded          -> ASSIGNMENT_GRADED to that student and their parents
 *   - attendance.sessionSubmitted -> ATTENDANCE_MARKED to the parents of each student marked absent/late
 *
 * The inbox rows and the event's `notify_dispatched_at` stamp commit in one transaction, so an event
 * notifies exactly once: a crash before COMMIT leaves the event pending and writes nothing. Push is
 * not done here -- every inbox row is picked up by the push consumer (push-consumer.ts), which is
 * what makes messages, announcements and fee notices reach phones too.
 *
 * An event older than {@link STALE_EVENT_MS} is stamped without notifying: a backlog drained after
 * an outage should not tell parents about last week's register as if it were news.
 */

import { NOTIFICATION_TYPES } from "@studafy/constants";

import { withSystemTenantTx } from "../../db/tenant-tx";
import { discoverPendingSchools } from "../outbox-discovery";
import { startPollLoop } from "../poll-loop";

import { render, resolveLocale, resolveRoute } from "./templates/renderer";

import type { PollLoopHandle } from "../poll-loop";
import type { NotificationType } from "@studafy/constants";
import type { TemplateLocale } from "@studafy/notification-templates";
import type { Sql, TransactionSql } from "postgres";

/** Must match the event names in idx_outbox_events_school_notify_pending (000216). */
export const NOTIFY_EVENT_NAMES = [
  "assignment.published",
  "submission.graded",
  "attendance.sessionSubmitted",
] as const;

const STALE_EVENT_MS = 2 * 24 * 60 * 60 * 1000;

/** The parent app's alert center (apps/mobile RoutePaths.parentAlerts). */
const PARENT_ALERTS_ROUTE = "/parent/alerts";
/** The parent app's home, which shows each child's work and fees. */
const PARENT_HOME_ROUTE = "/";

interface OutboxRow {
  id: string;
  event_name: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

/** One inbox row to write. */
export interface PendingNotification {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata: Record<string, string>;
}

interface Person {
  studentId: string;
  studentName: string;
  /** The student's own active account, if any. */
  studentUserId: string | null;
  /** Active linked parent accounts. */
  parentUserIds: string[];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Each student with their own active account and their active linked parents. */
async function loadPeople(
  tx: TransactionSql,
  schoolId: string,
  studentIds: string[],
): Promise<Person[]> {
  if (studentIds.length === 0) return [];
  const rows = await tx<
    {
      student_id: string;
      student_name: string;
      student_user_id: string | null;
      parent_user_ids: string[] | null;
    }[]
  >`
    SELECT
      student.id AS student_id,
      btrim(coalesce(student.preferred_name, student.first_name) || ' ' || student.last_name)
        AS student_name,
      CASE WHEN student_user.status = 'active' THEN student.user_id END AS student_user_id,
      (
        SELECT array_agg(DISTINCT link.parent_user_id)
        FROM app.parent_child_links AS link
        JOIN app.users AS parent_user
          ON parent_user.id = link.parent_user_id
         AND parent_user.school_id = link.school_id
        WHERE link.school_id = student.school_id
          AND link.student_id = student.id
          AND parent_user.status = 'active'
      ) AS parent_user_ids
    FROM app.students AS student
    LEFT JOIN app.users AS student_user
      ON student_user.id = student.user_id
     AND student_user.school_id = student.school_id
    WHERE student.school_id = ${schoolId}::uuid
      AND student.id = ANY(${studentIds}::uuid[])
    ORDER BY student.id
  `;
  return rows.map((row) => ({
    studentId: row.student_id,
    studentName: row.student_name,
    studentUserId: row.student_user_id,
    parentUserIds: row.parent_user_ids ?? [],
  }));
}

/** Each recipient's template locale: their own setting, then the school's, then English. */
async function loadLocales(
  tx: TransactionSql,
  schoolId: string,
  userIds: string[],
): Promise<Map<string, TemplateLocale>> {
  if (userIds.length === 0) return new Map();
  const rows = await tx<
    { user_id: string; recipient_locale: string | null; school_locale: string | null }[]
  >`
    SELECT target_user.id AS user_id,
           settings.locale AS recipient_locale,
           school_settings.locale AS school_locale
    FROM app.users AS target_user
    LEFT JOIN app.user_notification_settings AS settings
      ON settings.user_id = target_user.id
     AND settings.school_id = target_user.school_id
    LEFT JOIN app.school_settings AS school_settings
      ON school_settings.school_id = target_user.school_id
    WHERE target_user.school_id = ${schoolId}::uuid
      AND target_user.id = ANY(${userIds}::uuid[])
  `;
  return new Map(
    rows.map((row) => [row.user_id, resolveLocale(row.recipient_locale, row.school_locale)]),
  );
}

/** Users who turned this type's in-app channel off. */
async function loadInAppOptOuts(
  tx: TransactionSql,
  userIds: string[],
  type: NotificationType,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await tx<{ user_id: string }[]>`
    SELECT user_id
    FROM app.notification_preferences
    WHERE user_id = ANY(${userIds}::uuid[])
      AND notification_type = ${type}::app.notification_type
      AND channel = 'in_app'
      AND enabled = false
  `;
  return new Set(rows.map((row) => row.user_id));
}

function formatNumber(value: string | number): string {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

// ---------------------------------------------------------------------------
// Event -> recipients
// ---------------------------------------------------------------------------

type Draft = Omit<PendingNotification, "title" | "body"> & {
  vars: Record<string, string>;
  localized?: (locale: TemplateLocale) => Record<string, string>;
};

async function assignmentPublished(
  tx: TransactionSql,
  schoolId: string,
  payload: Record<string, unknown>,
): Promise<Draft[]> {
  const assignmentId = String(payload.assignmentId ?? "");
  if (!assignmentId) return [];
  const [assignment] = await tx<
    {
      id: string;
      title: string;
      class_id: string;
      course_id: string;
      course_name: string;
      due_date: string;
    }[]
  >`
    SELECT assignment.id, assignment.title, assignment.class_id, class_row.course_id,
           course.name AS course_name,
           to_char(assignment.due_at AT TIME ZONE coalesce(school_settings.timezone, 'UTC'),
                   'YYYY-MM-DD') AS due_date
    FROM app.assignments AS assignment
    JOIN app.classes AS class_row
      ON class_row.id = assignment.class_id AND class_row.school_id = assignment.school_id
    JOIN app.courses AS course
      ON course.id = class_row.course_id AND course.school_id = class_row.school_id
    LEFT JOIN app.school_settings AS school_settings
      ON school_settings.school_id = assignment.school_id
    WHERE assignment.id = ${assignmentId}::uuid
      AND assignment.school_id = ${schoolId}::uuid
      AND assignment.status = 'published'
  `;
  if (!assignment) return [];

  const enrolled = await tx<{ student_id: string }[]>`
    SELECT DISTINCT student_id
    FROM app.enrollments
    WHERE school_id = ${schoolId}::uuid
      AND class_id = ${assignment.class_id}::uuid
      AND status = 'active'
  `;
  const people = await loadPeople(
    tx,
    schoolId,
    enrolled.map((row) => row.student_id),
  );

  const type = NOTIFICATION_TYPES.ASSIGNMENT_PUBLISHED;
  const studentRoute = resolveRoute(type, {
    courseId: assignment.course_id,
    assignmentId: assignment.id,
  });
  const base = {
    assignmentTitle: assignment.title,
    courseName: assignment.course_name,
    dueDate: assignment.due_date,
  };
  const ids = {
    assignment_id: assignment.id,
    class_id: assignment.class_id,
    course_id: assignment.course_id,
  };

  return fanOut(people, type, {
    student: { vars: { ...base, who: "" }, metadata: { ...ids, route: studentRoute } },
    parent: (person) => ({
      vars: { ...base, who: `${person.studentName} · ` },
      metadata: { ...ids, route: PARENT_HOME_ROUTE },
    }),
  });
}

async function submissionGraded(
  tx: TransactionSql,
  schoolId: string,
  payload: Record<string, unknown>,
): Promise<Draft[]> {
  const submissionId = String(payload.submissionId ?? "");
  if (!submissionId) return [];
  const [row] = await tx<
    {
      student_id: string;
      score: string | null;
      max_score: string;
      assignment_id: string;
      title: string;
      class_id: string;
      course_id: string;
      course_name: string;
    }[]
  >`
    SELECT submission.student_id, submission.score::text AS score,
           assignment.max_score::text AS max_score, assignment.id AS assignment_id,
           assignment.title, assignment.class_id, class_row.course_id, course.name AS course_name
    FROM app.assignment_submissions AS submission
    JOIN app.assignments AS assignment
      ON assignment.id = submission.assignment_id AND assignment.school_id = submission.school_id
    JOIN app.classes AS class_row
      ON class_row.id = assignment.class_id AND class_row.school_id = assignment.school_id
    JOIN app.courses AS course
      ON course.id = class_row.course_id AND course.school_id = class_row.school_id
    WHERE submission.id = ${submissionId}::uuid
      AND submission.school_id = ${schoolId}::uuid
      AND submission.grade_status = 'published'
  `;
  if (!row) return [];

  const people = await loadPeople(tx, schoolId, [row.student_id]);
  const type = NOTIFICATION_TYPES.ASSIGNMENT_GRADED;
  const studentRoute = resolveRoute(type, {
    courseId: row.course_id,
    assignmentId: row.assignment_id,
  });
  const result = (locale: TemplateLocale): string => {
    if (row.score === null) return locale === "ar" ? "الملاحظات جاهزة" : "Feedback is ready";
    const score = formatNumber(row.score);
    const max = formatNumber(row.max_score);
    return locale === "ar" ? `الدرجة ${score} من ${max}` : `Score ${score} / ${max}`;
  };
  const base = { assignmentTitle: row.title, courseName: row.course_name };
  const ids = {
    assignment_id: row.assignment_id,
    submission_id: submissionId,
    class_id: row.class_id,
    course_id: row.course_id,
  };

  return fanOut(people, type, {
    student: {
      vars: { ...base, who: "" },
      localized: (locale) => ({ result: result(locale) }),
      metadata: { ...ids, route: studentRoute },
    },
    parent: (person) => ({
      vars: { ...base, who: `${person.studentName} · ` },
      localized: (locale) => ({ result: result(locale) }),
      metadata: { ...ids, route: PARENT_HOME_ROUTE },
    }),
  });
}

async function attendanceSubmitted(
  tx: TransactionSql,
  schoolId: string,
  payload: Record<string, unknown>,
): Promise<Draft[]> {
  const sessionId = String(payload.sessionId ?? "");
  if (!sessionId) return [];
  const rows = await tx<
    {
      student_id: string;
      status: "absent" | "late";
      class_id: string;
      course_name: string;
      session_date: string;
    }[]
  >`
    SELECT record.student_id, record.status::text AS status, session.class_id,
           course.name AS course_name, session.session_date::text AS session_date
    FROM app.attendance_sessions AS session
    JOIN app.attendance_records AS record
      ON record.attendance_session_id = session.id
     AND record.school_id = session.school_id
     AND record.session_created_at = session.created_at
    JOIN app.classes AS class_row
      ON class_row.id = session.class_id AND class_row.school_id = session.school_id
    JOIN app.courses AS course
      ON course.id = class_row.course_id AND course.school_id = class_row.school_id
    WHERE session.id = ${sessionId}::uuid
      AND session.school_id = ${schoolId}::uuid
      AND session.status IN ('submitted', 'locked')
      AND record.status IN ('absent', 'late')
    ORDER BY record.student_id
  `;
  if (rows.length === 0) return [];

  const byStudent = new Map(rows.map((row) => [row.student_id, row]));
  const people = await loadPeople(tx, schoolId, [...byStudent.keys()]);
  const type = NOTIFICATION_TYPES.ATTENDANCE_MARKED;
  const drafts: Draft[] = [];
  for (const person of people) {
    const record = byStudent.get(person.studentId)!;
    for (const parentUserId of person.parentUserIds) {
      drafts.push({
        userId: parentUserId,
        type,
        vars: {
          studentName: person.studentName,
          courseName: record.course_name,
          date: record.session_date,
        },
        localized: (locale) => ({
          status: locale === "ar" ? (record.status === "absent" ? "غياب" : "تأخير") : record.status,
        }),
        metadata: {
          route: PARENT_ALERTS_ROUTE,
          student_id: person.studentId,
          class_id: record.class_id,
          attendance_session_id: sessionId,
          status: record.status,
        },
      });
    }
  }
  return drafts;
}

interface Audience {
  vars: Record<string, string>;
  localized?: (locale: TemplateLocale) => Record<string, string>;
  metadata: Record<string, string>;
}

/** One draft for each student's own account and one for each of their parents. */
function fanOut(
  people: Person[],
  type: NotificationType,
  audience: { student: Audience; parent: (person: Person) => Audience },
): Draft[] {
  const drafts: Draft[] = [];
  for (const person of people) {
    if (person.studentUserId) {
      drafts.push({
        userId: person.studentUserId,
        type,
        vars: audience.student.vars,
        localized: audience.student.localized,
        metadata: { ...audience.student.metadata, student_id: person.studentId },
      });
    }
    const forParents = audience.parent(person);
    for (const parentUserId of person.parentUserIds) {
      drafts.push({
        userId: parentUserId,
        type,
        vars: forParents.vars,
        localized: forParents.localized,
        metadata: { ...forParents.metadata, student_id: person.studentId },
      });
    }
  }
  return drafts;
}

const HANDLERS: Record<
  (typeof NOTIFY_EVENT_NAMES)[number],
  (tx: TransactionSql, schoolId: string, payload: Record<string, unknown>) => Promise<Draft[]>
> = {
  "assignment.published": assignmentPublished,
  "submission.graded": submissionGraded,
  "attendance.sessionSubmitted": attendanceSubmitted,
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Render each draft in its recipient's locale and drop the ones the recipient opted out of. */
async function finalize(
  tx: TransactionSql,
  schoolId: string,
  drafts: Draft[],
): Promise<PendingNotification[]> {
  if (drafts.length === 0) return [];
  const userIds = [...new Set(drafts.map((draft) => draft.userId))];
  const locales = await loadLocales(tx, schoolId, userIds);
  const optOuts = new Map<NotificationType, Set<string>>();
  for (const type of new Set(drafts.map((draft) => draft.type))) {
    optOuts.set(type, await loadInAppOptOuts(tx, userIds, type));
  }

  const out: PendingNotification[] = [];
  for (const draft of drafts) {
    if (optOuts.get(draft.type)?.has(draft.userId)) continue;
    const locale = locales.get(draft.userId) ?? "en";
    const vars = { ...draft.vars, ...(draft.localized?.(locale) ?? {}) };
    const { title, body } = render(draft.type, "push", locale, vars);
    out.push({ userId: draft.userId, type: draft.type, title, body, metadata: draft.metadata });
  }
  return out;
}

async function insertNotifications(
  tx: TransactionSql,
  schoolId: string,
  notifications: PendingNotification[],
): Promise<void> {
  for (const notification of notifications) {
    // tx.json(), not JSON.stringify() + ::jsonb -- see the note in dispatcher.worker.ts.
    await tx`
      INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
      VALUES (
        ${schoolId}::uuid,
        ${notification.userId}::uuid,
        ${notification.type}::app.notification_type,
        ${notification.title},
        ${notification.body},
        ${tx.json(notification.metadata)}
      )
    `;
  }
}

/**
 * Turn one school's pending events into inbox rows. Returns the number of events consumed, so the
 * poll loop knows whether to go straight round again.
 */
export async function notifySchoolEvents(
  db: Sql,
  schoolId: string,
  batchSize: number,
  now: Date = new Date(),
): Promise<{ events: number; notifications: number }> {
  return withSystemTenantTx(db, { schoolId }, async (tx) => {
    const events = await tx<OutboxRow[]>`
      SELECT id, event_name, payload, created_at
      FROM app.outbox_events
      WHERE school_id = ${schoolId}::uuid
        AND notify_dispatched_at IS NULL
        AND event_name IN ${tx([...NOTIFY_EVENT_NAMES])}
      ORDER BY id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;
    if (events.length === 0) return { events: 0, notifications: 0 };

    let written = 0;
    for (const event of events) {
      if (now.getTime() - new Date(event.created_at).getTime() > STALE_EVENT_MS) continue;
      const handler = HANDLERS[event.event_name as (typeof NOTIFY_EVENT_NAMES)[number]];
      if (!handler) continue;
      const drafts = await handler(tx, schoolId, event.payload ?? {});
      const notifications = await finalize(tx, schoolId, drafts);
      await insertNotifications(tx, schoolId, notifications);
      written += notifications.length;
    }

    await tx`
      UPDATE app.outbox_events
      SET notify_dispatched_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}::uuid
        AND id IN ${tx(events.map((event) => event.id))}
    `;
    return { events: events.length, notifications: written };
  });
}

export interface SchoolEventNotifierLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

/** The always-on loop: discover schools with pending events, drain each. */
export function startSchoolEventNotifier(ctx: {
  db: Sql;
  logger: SchoolEventNotifierLogger;
  batchSize?: number;
  pollIntervalMs?: number;
  maxIdleIntervalMs?: number;
}): PollLoopHandle {
  const batchSize = ctx.batchSize ?? 50;
  return startPollLoop({
    minIdleMs: ctx.pollIntervalMs ?? 1_000,
    maxIdleMs: ctx.maxIdleIntervalMs ?? 5_000,
    cycle: async () => {
      let total = 0;
      for (const schoolId of await discoverPendingSchools(ctx.db, "notify")) {
        try {
          const result = await notifySchoolEvents(ctx.db, schoolId, batchSize);
          total += result.events;
          if (result.notifications > 0) {
            ctx.logger.info(
              { school_id: schoolId, events: result.events, notifications: result.notifications },
              "school events notified",
            );
          }
        } catch (err) {
          ctx.logger.error({ err, school_id: schoolId }, "school event notify failed");
        }
      }
      return total;
    },
    onError: (err) => ctx.logger.error({ err }, "school event notify cycle failed"),
  });
}
