/**
 * Attendance alert engine (ST-110).
 *
 * Consumes one job per attendance submission, evaluates each absent student against the school's
 * configured thresholds, and notifies every linked parent — at most once per breach, ever.
 *
 * ## Why the dedup claim comes before the notification
 *
 * The acceptance criterion is zero duplicate alerts under BullMQ retries, duplicate enqueues, and
 * concurrent workers. That cannot be met by checking-then-writing, however careful the check: two
 * processes can both read "not yet sent" before either writes. So the order is inverted — the
 * worker first *claims* the alert with an `INSERT ... ON CONFLICT DO NOTHING`, and only sends if
 * the insert returned a row. The unique index is the arbiter, so the guarantee is the database's
 * rather than the application's.
 *
 * The cost of that ordering is a visible orphan: a crash between claim and notification leaves a
 * log row with a null `notification_id`. That is the right way round — an alert that was recorded
 * but not delivered is a diagnosable gap, whereas one delivered twice is an angry parent and an
 * unfixable record.
 *
 * ## Why absence windows join up to sessions
 *
 * `app.attendance_records` deliberately carries no `attendance_date` and no `class_id` — both are
 * functionally dependent on the session (see 000012). Every "how many days was this student
 * absent" question therefore joins records up to `app.attendance_sessions` for `session_date`.
 * Both tables are RANGE-partitioned monthly on `created_at`, so both sides of that join carry a
 * `created_at` lower bound purely so the planner can prune partitions.
 */

import { DOMAIN_EVENTS, NOTIFICATION_TYPES } from "@studafy/constants";
import postgres from "postgres";

import { withSystemTenantTx } from "../../db/tenant-tx";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AttendanceAlertRuleType = "consecutive_days" | "period_count";

export interface AttendanceAlertJobData {
  schoolId: string;
  attendanceSessionId: string;
  /** The session's business date, YYYY-MM-DD. The anchor for every window and every dedup key. */
  sessionDate: string;
  /** Students marked absent in the submission that triggered this job. */
  studentIds: string[];
}

export interface AttendanceAlertRule {
  rule_type: AttendanceAlertRuleType;
  threshold_value: number;
  window_days: number | null;
}

export interface AttendanceAlertResult {
  processed: true;
  studentsEvaluated: number;
  /** Notifications actually written — one per (student, parent, breach) newly claimed. */
  alertsSent: number;
  /** Claims lost to an earlier run. Non-zero here is the dedup working, not a fault. */
  duplicatesSkipped: number;
}

interface AbsenceDay {
  session_date: string;
  absent: boolean;
}

interface Breach {
  rule: AttendanceAlertRule;
  absentDays: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Applied when a school has configured no active rules.
 *
 * A school that has never opened an alerts settings page must still get alerting — a missing
 * configuration row means "not customised", not "disabled". Mirrors
 * DEFAULT_CORRECTION_WINDOW_HOURS in the ST-109 correction service.
 */
export const DEFAULT_ALERT_RULES: readonly AttendanceAlertRule[] = [
  { rule_type: "consecutive_days", threshold_value: 3, window_days: null },
];

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` shifted by whole days, in UTC. Business dates are calendar dates, never instants. */
function shiftDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The school's armed rules, or the built-in default when it has configured none. */
export async function loadAlertRules(
  tx: TransactionSql,
  schoolId: string,
): Promise<readonly AttendanceAlertRule[]> {
  const rows = await tx<Record<string, unknown>[]>`
    SELECT rule_type::text AS rule_type, threshold_value, window_days
    FROM app.attendance_alert_rules
    WHERE school_id = ${schoolId}::uuid
      AND is_active
    ORDER BY rule_type
  `;

  if (rows.length === 0) return DEFAULT_ALERT_RULES;

  return rows.map((row) => ({
    rule_type: row.rule_type as AttendanceAlertRuleType,
    threshold_value: row.threshold_value as number,
    window_days: row.window_days as number | null,
  }));
}

/**
 * One row per school day in the window, flagged absent if the student missed *any* period that day.
 *
 * `bool_or` is the collapse: a student absent for period 1 and present for period 5 was absent that
 * day for alerting purposes. Counting periods instead would make a school with eight periods
 * breach a three-day threshold before lunch.
 *
 * Days with no session at all — weekends, holidays — produce no row, so they neither count as
 * absent nor break a consecutive run.
 */
async function loadAbsenceDays(
  tx: TransactionSql,
  studentId: string,
  fromDate: string,
  toDate: string,
): Promise<AbsenceDay[]> {
  const rows = await tx<Record<string, unknown>[]>`
    SELECT session_date::text AS session_date, absent
    FROM app.student_absence_days(${studentId}::uuid, ${fromDate}::date, ${toDate}::date)
  `;

  return rows.map((row) => ({
    session_date: row.session_date as string,
    absent: row.absent as boolean,
  }));
}

/** Every parent linked to the student, in a stable order. */
async function loadLinkedParents(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<string[]> {
  const rows = await tx<{ parent_user_id: string }[]>`
    SELECT parent_user_id
    FROM app.parent_child_links
    WHERE school_id = ${schoolId}::uuid
      AND student_id = ${studentId}::uuid
    ORDER BY parent_user_id
  `;
  return rows.map((row) => row.parent_user_id);
}

async function loadStudentName(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<string | null> {
  const [row] = await tx<{ full_name: string }[]>`
    SELECT btrim(coalesce(preferred_name, first_name) || ' ' || last_name) AS full_name
    FROM app.students
    WHERE id = ${studentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  return row?.full_name ?? null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * The unbroken run of absent school days ending on `boundaryDate`.
 *
 * Returns 0 unless the student was absent on the boundary date itself — the run must *end* at the
 * triggering day, or this is history rather than an alert.
 */
export function countConsecutiveAbsences(days: AbsenceDay[], boundaryDate: string): number {
  const ordered = [...days].sort((a, b) => (a.session_date < b.session_date ? 1 : -1));
  if (ordered[0]?.session_date !== boundaryDate || !ordered[0].absent) return 0;

  let run = 0;
  for (const day of ordered) {
    if (!day.absent) break;
    run += 1;
  }
  return run;
}

/** Absent school days within `windowDays` ending on `boundaryDate`, inclusive of both ends. */
export function countAbsencesInWindow(
  days: AbsenceDay[],
  boundaryDate: string,
  windowDays: number,
): number {
  const from = shiftDate(boundaryDate, -(windowDays - 1));
  return days.filter(
    (day) => day.absent && day.session_date >= from && day.session_date <= boundaryDate,
  ).length;
}

/** Evaluate every rule, returning only those the student has crossed. */
export function evaluateRules(
  rules: readonly AttendanceAlertRule[],
  days: AbsenceDay[],
  boundaryDate: string,
): Breach[] {
  const breaches: Breach[] = [];

  for (const rule of rules) {
    const absentDays =
      rule.rule_type === "consecutive_days"
        ? countConsecutiveAbsences(days, boundaryDate)
        : countAbsencesInWindow(days, boundaryDate, rule.window_days ?? rule.threshold_value);

    if (absentDays >= rule.threshold_value) {
      breaches.push({ rule, absentDays });
    }
  }

  return breaches;
}

/**
 * `<rule_type>:<threshold_value>:<boundary_date>`.
 *
 * School, student and parent are columns of the log table and stay out of the string rather than
 * being duplicated inside it. The threshold is part of the key deliberately: a school raising its
 * bar is a different alerting condition, and should be able to re-alert.
 */
export function buildDedupKey(rule: AttendanceAlertRule, boundaryDate: string): string {
  return `${rule.rule_type}:${rule.threshold_value}:${boundaryDate}`;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Claim the right to alert one parent about one breach.
 *
 * Returns the log id when this call won the claim, `null` when an earlier run already holds it.
 * This is the single point at which duplicate suppression happens.
 */
async function claimAlert(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  parentUserId: string,
  breach: Breach,
  dedupKey: string,
  jobId: string | null,
): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.attendance_alert_logs (
      school_id, student_id, parent_user_id, rule_type, threshold_value, dedup_key, trigger_job_id
    ) VALUES (
      ${schoolId}::uuid,
      ${studentId}::uuid,
      ${parentUserId}::uuid,
      ${breach.rule.rule_type}::app.attendance_alert_rule_type,
      ${breach.rule.threshold_value}::smallint,
      ${dedupKey},
      ${jobId}
    )
    ON CONFLICT ON CONSTRAINT uq_attendance_alert_logs_dedup DO NOTHING
    RETURNING id
  `;
  return row?.id ?? null;
}

async function writeNotification(
  tx: TransactionSql,
  schoolId: string,
  parentUserId: string,
  studentId: string,
  studentName: string | null,
  breach: Breach,
  boundaryDate: string,
): Promise<string> {
  const subject = studentName ?? "Your child";
  const body =
    breach.rule.rule_type === "consecutive_days"
      ? `${subject} has been absent for ${breach.absentDays} consecutive school days, as of ${boundaryDate}.`
      : `${subject} has been absent for ${breach.absentDays} school days recently, as of ${boundaryDate}.`;

  // tx.json(), not JSON.stringify() + ::jsonb. With an explicit ::jsonb cast postgres.js infers
  // the parameter type as jsonb and JSON-encodes the string it was given, producing a jsonb
  // *string* rather than an object — which ck_notifications_metadata rejects outright. The same
  // mistake against app.outbox_events, which has no such CHECK, would store silently and corrupt
  // every consumer downstream.
  const metadata = tx.json({
    student_id: studentId,
    rule_type: breach.rule.rule_type,
    threshold_value: breach.rule.threshold_value,
    absent_days: breach.absentDays,
    boundary_date: boundaryDate,
  });

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
    VALUES (
      ${schoolId}::uuid,
      ${parentUserId}::uuid,
      ${NOTIFICATION_TYPES.ATTENDANCE_ALERT}::app.notification_type,
      'Attendance alert',
      ${body},
      ${metadata}
    )
    RETURNING id
  `;
  return row!.id;
}

/**
 * Outbox row for the breach, written in the same transaction as the notifications it describes.
 *
 * Constructed by hand rather than through apps/api's `emit()` — apps/workers does not depend on
 * apps/api. The shape must match `eventPayloadSchemas[ATTENDANCE_ALERT_RAISED]` in
 * apps/api/src/lib/events/schemas.ts, which is the contract of record; that map is exhaustive over
 * DOMAIN_EVENTS, so the event cannot exist without a schema there.
 *
 * One event per breach, not per parent: consumers care that the threshold was crossed, and the
 * recipient list is a property of that fact.
 */
async function emitAlertRaised(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  breach: Breach,
  boundaryDate: string,
  parentUserIds: string[],
): Promise<void> {
  // See writeNotification for why this is tx.json() rather than a stringify + ::jsonb cast.
  const payload = tx.json({
    studentId,
    ruleType: breach.rule.rule_type,
    thresholdValue: breach.rule.threshold_value,
    absentDays: breach.absentDays,
    boundaryDate,
    parentUserIds,
  });

  await tx`
    INSERT INTO app.outbox_events (school_id, event_name, payload)
    VALUES (${schoolId}::uuid, ${DOMAIN_EVENTS.ATTENDANCE_ALERT_RAISED}, ${payload})
  `;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Evaluate one attendance submission and alert on any thresholds it crossed.
 *
 * `databaseUrl` is a parameter rather than read from the environment so the processor is callable
 * from a test against a disposable database — the shape processBulkInvite and processStudentImport
 * already establish.
 */
export async function processAttendanceAlert(
  data: AttendanceAlertJobData,
  databaseUrl: string,
  jobId: string | null = null,
): Promise<AttendanceAlertResult> {
  const { schoolId, sessionDate, studentIds } = data;

  if (studentIds.length === 0) {
    return { processed: true, studentsEvaluated: 0, alertsSent: 0, duplicatesSkipped: 0 };
  }

  // prepare: false is mandatory — the runtime sits behind PgBouncer in transaction pooling mode,
  // where server-side prepared statements do not survive between transactions.
  const sql = postgres(databaseUrl, { max: 4, idle_timeout: 20, prepare: false });

  let alertsSent = 0;
  let duplicatesSkipped = 0;

  try {
    // One transaction per student rather than one for the whole job: a job covers a whole class,
    // and one student's failure should not roll back alerts already sent for their classmates.
    for (const studentId of studentIds) {
      const outcome = await withSystemTenantTx(sql, { schoolId }, async (tx) => {
        const rules = await loadAlertRules(tx, schoolId);

        // Widest lookback any rule needs, so one query serves them all.
        const lookbackDays = Math.max(
          ...rules.map((rule) =>
            rule.rule_type === "consecutive_days"
              ? rule.threshold_value
              : (rule.window_days ?? rule.threshold_value),
          ),
        );

        const days = await loadAbsenceDays(
          tx,
          studentId,
          shiftDate(sessionDate, -(lookbackDays - 1)),
          sessionDate,
        );

        const breaches = evaluateRules(rules, days, sessionDate);
        if (breaches.length === 0) return { sent: 0, skipped: 0 };

        const parentUserIds = await loadLinkedParents(tx, schoolId, studentId);
        // A student with no linked parent is not an error — an alert with no recipient simply has
        // nothing to do, and claiming it would suppress a later alert once a parent is linked.
        if (parentUserIds.length === 0) return { sent: 0, skipped: 0 };

        const studentName = await loadStudentName(tx, schoolId, studentId);

        let sent = 0;
        let skipped = 0;

        for (const breach of breaches) {
          const dedupKey = buildDedupKey(breach.rule, sessionDate);
          const notified: string[] = [];

          for (const parentUserId of parentUserIds) {
            const logId = await claimAlert(
              tx,
              schoolId,
              studentId,
              parentUserId,
              breach,
              dedupKey,
              jobId,
            );

            if (logId === null) {
              skipped += 1;
              continue;
            }

            const notificationId = await writeNotification(
              tx,
              schoolId,
              parentUserId,
              studentId,
              studentName,
              breach,
              sessionDate,
            );

            await tx`
              UPDATE app.attendance_alert_logs
              SET notification_id = ${notificationId}::uuid
              WHERE id = ${logId}::uuid AND school_id = ${schoolId}::uuid
            `;

            notified.push(parentUserId);
            sent += 1;
          }

          // Only when this run actually notified someone. A replay that claimed nothing must not
          // re-announce a breach downstream consumers already saw.
          if (notified.length > 0) {
            await emitAlertRaised(tx, schoolId, studentId, breach, sessionDate, notified);
          }
        }

        return { sent, skipped };
      });

      alertsSent += outcome.sent;
      duplicatesSkipped += outcome.skipped;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  return {
    processed: true,
    studentsEvaluated: studentIds.length,
    alertsSent,
    duplicatesSkipped,
  };
}
