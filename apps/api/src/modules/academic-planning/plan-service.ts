import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import {
  assertCanReadSectionSubject,
  assertCoordinatesSubject,
  requireYear,
} from "../grading/access";
import { requireEffectiveSubject, requireSectionRow } from "../grading/engine-config";

import { getPlanningSettings } from "./settings-service";

import type { SectionRow } from "../grading/engine-config";
import type { PendingQuery, Row, TransactionSql } from "postgres";

type Fragment = PendingQuery<Row[]>;

/**
 * Term and lesson plans (000268).
 *
 * A teacher of the section and subject writes them (in the app), and submits them for review; the
 * subject's coordinator (000261, in the app) or school leadership (on the web) approves or returns
 * them with a comment. A returned plan is edited and submitted again; an approved one is final,
 * except a lesson's reflection, which the teacher writes after teaching it. Every write and review
 * is audited with the old and new status.
 *
 * Rows are visible to leadership, the section's subject teachers and the subject's coordinator only
 * (RLS, app.can_read_section_subject_work): anyone else gets 404, as if the plan did not exist.
 *
 * "On time" is measured from the first submission, in the school's timezone: a term plan by the
 * term's first day plus `term_plan_due_days`, a lesson plan `lesson_plan_lead_days` before the
 * lesson. Resubmitting a returned plan does not change it.
 */

export type PlanStatus = "draft" | "submitted" | "approved" | "returned";
export type ReviewDecision = "approve" | "return";

export const TERM_PLAN_NOTES_MAX = 5000;
export const TERM_PLAN_WEEKS_MAX = 60;
export const WEEK_UNIT_MAX = 200;
export const WEEK_NOTES_MAX = 2000;
export const LESSON_TITLE_MAX = 200;
export const LESSON_LONG_TEXT_MAX = 4000;
export const LESSON_TEXT_MAX = 2000;
export const REVIEW_COMMENT_MAX = 2000;
export const PLAN_OUTCOMES_MAX = 50;
export const PLAN_MATERIALS_MAX = 20;
const LIST_LIMIT = 500;

const DEFAULT_TIMEZONE = "Africa/Casablanca";

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function invalid(message: string): never {
  throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, message);
}

function notFound(what: string): never {
  throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, `${what} not found`);
}

function wrongState(message: string): never {
  throw new CodedHttpException(409, ERROR_CODES.CONFLICT_STATE_MISMATCH, message);
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

interface PlanAccess {
  leadership: boolean;
  teaches: boolean;
  coordinates: boolean;
}

async function planAccess(
  tx: TransactionSql,
  sectionId: string,
  subjectId: string,
): Promise<PlanAccess> {
  const [row] = await tx<PlanAccess[]>`
    SELECT app.current_user_is_school_admin() AS leadership,
           app.teaches_section_subject(${sectionId}::uuid, ${subjectId}::uuid) AS teaches,
           app.coordinates_section_subject(${sectionId}::uuid, ${subjectId}::uuid) AS coordinates
  `;
  return row ?? { leadership: false, teaches: false, coordinates: false };
}

/** Plans are the teachers' own: only a teacher of the subject in the section writes them. */
async function assertTeaches(tx: TransactionSql, sectionId: string, subjectId: string) {
  const access = await planAccess(tx, sectionId, subjectId);
  if (!access.teaches) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "Only a teacher of this subject in this section writes its plans",
    );
  }
  return access;
}

interface PlanPermissions {
  can_edit: boolean;
  can_submit: boolean;
  can_delete: boolean;
  can_review: boolean;
}

function permissionsFor(
  access: PlanAccess,
  plan: { status: PlanStatus; author_user_id: string },
  userId: string,
): PlanPermissions {
  const open = plan.status === "draft" || plan.status === "returned";
  return {
    can_edit: access.teaches && open,
    can_submit: access.teaches && open,
    can_delete: access.teaches && plan.status === "draft",
    can_review:
      plan.status === "submitted" &&
      (access.leadership || access.coordinates) &&
      plan.author_user_id !== userId,
  };
}

/** The subject is taught to the section; returns the section. */
async function requireSectionSubject(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
): Promise<SectionRow & { subject_name: string }> {
  const section = await requireSectionRow(tx, schoolId, sectionId);
  const subject = await requireEffectiveSubject(tx, schoolId, section, subjectId);
  return { ...section, subject_name: subject.subject_name };
}

/** Every id is an outcome of the subject for the section's grade level (archived ones included). */
async function assertOutcomes(
  tx: TransactionSql,
  schoolId: string,
  subjectId: string,
  gradeLevelId: string,
  outcomeIds: readonly string[],
): Promise<void> {
  if (outcomeIds.length === 0) return;
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM app.learning_outcomes
    WHERE school_id = ${schoolId}::uuid AND subject_id = ${subjectId}::uuid
      AND grade_level_id = ${gradeLevelId}::uuid AND id = ANY (${[...outcomeIds]}::uuid[])
  `;
  const known = new Set(rows.map((row) => row.id));
  const unknown = outcomeIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    invalid(`Not an outcome of this subject and grade: ${unknown.slice(0, 5).join(", ")}`);
  }
}

function assertDistinct(ids: readonly string[], what: string): void {
  if (new Set(ids).size !== ids.length) invalid(`Each ${what} may appear only once`);
}

export interface PlanOutcome {
  id: string;
  code: string;
  text: string;
  text_ar: string | null;
  strand: string | null;
}

async function outcomesById(
  tx: TransactionSql,
  schoolId: string,
  ids: readonly string[],
): Promise<Map<string, PlanOutcome>> {
  if (ids.length === 0) return new Map();
  const rows = await tx<(PlanOutcome & { sort_order: number })[]>`
    SELECT id, code, text, text_ar, strand, sort_order FROM app.learning_outcomes
    WHERE school_id = ${schoolId}::uuid AND id = ANY (${[...new Set(ids)]}::uuid[])
    ORDER BY sort_order, code
  `;
  return new Map(rows.map(({ sort_order: _sort, ...row }) => [row.id, row]));
}

const ordered = (ids: readonly string[], byId: Map<string, PlanOutcome>): PlanOutcome[] =>
  [...byId.values()].filter((outcome) => ids.includes(outcome.id));

// ---------------------------------------------------------------------------
// Shared plan header
// ---------------------------------------------------------------------------

interface PlanHeaderRow {
  id: string;
  academic_year_id: string;
  term_id: string | null;
  term_name: string | null;
  section_id: string;
  section_name: string;
  grade_level_id: string;
  grade_level_name: string;
  subject_id: string;
  subject_name: string;
  author_user_id: string;
  author_name: string | null;
  status: PlanStatus;
  first_submitted_at: Date | null;
  submitted_at: Date | null;
  reviewed_at: Date | null;
  reviewed_by_user_id: string | null;
  reviewed_by_name: string | null;
  review_comment: string | null;
  due_on: string | null;
  on_time: boolean | null;
  created_at: Date;
  updated_at: Date;
}

export interface PlanHeader extends Omit<
  PlanHeaderRow,
  "first_submitted_at" | "submitted_at" | "reviewed_at" | "created_at" | "updated_at"
> {
  first_submitted_at: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

function toHeader(row: PlanHeaderRow): PlanHeader {
  return {
    ...row,
    first_submitted_at: iso(row.first_submitted_at),
    submitted_at: iso(row.submitted_at),
    reviewed_at: iso(row.reviewed_at),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** The joins every plan header needs; `plan` is the plan table's alias. */
function headerJoins(tx: TransactionSql) {
  return tx`
    JOIN app.sections AS section
      ON section.id = plan.section_id AND section.school_id = plan.school_id
    JOIN app.grade_levels AS grade
      ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    JOIN app.subjects AS subject
      ON subject.id = plan.subject_id AND subject.school_id = plan.school_id
    LEFT JOIN app.terms AS term ON term.id = plan.term_id AND term.school_id = plan.school_id
    LEFT JOIN app.users AS author
      ON author.id = plan.author_user_id AND author.school_id = plan.school_id
    LEFT JOIN app.users AS reviewer
      ON reviewer.id = plan.reviewed_by_user_id AND reviewer.school_id = plan.school_id
    LEFT JOIN app.school_settings AS school_settings ON school_settings.school_id = plan.school_id
  `;
}

function headerColumns(tx: TransactionSql, dueOn: Fragment) {
  return tx`
    plan.id, plan.academic_year_id, plan.term_id, term.name AS term_name, plan.section_id,
    section.name AS section_name, section.grade_level_id, grade.name AS grade_level_name,
    plan.subject_id, subject.name AS subject_name, plan.author_user_id,
    author.display_name AS author_name, plan.status, plan.first_submitted_at, plan.submitted_at,
    plan.reviewed_at, plan.reviewed_by_user_id, reviewer.display_name AS reviewed_by_name,
    plan.review_comment, (${dueOn})::text AS due_on,
    CASE
      WHEN plan.first_submitted_at IS NULL OR (${dueOn}) IS NULL THEN NULL
      ELSE (plan.first_submitted_at AT TIME ZONE
              coalesce(school_settings.timezone, ${DEFAULT_TIMEZONE}))::date <= (${dueOn})
    END AS on_time,
    plan.created_at, plan.updated_at
  `;
}

const termDueOn = (tx: TransactionSql, dueDays: number) => tx`term.starts_on + ${dueDays}::int`;
const lessonDueOn = (tx: TransactionSql, leadDays: number) =>
  tx`plan.lesson_date - ${leadDays}::int`;

// ---------------------------------------------------------------------------
// Term plans
// ---------------------------------------------------------------------------

export interface TermPlanWeekInput {
  week_number: number;
  starts_on?: string | null;
  unit?: string | null;
  notes?: string | null;
  outcome_ids: string[];
}

export interface TermPlanInput {
  notes?: string | null;
  weeks: TermPlanWeekInput[];
}

export interface TermPlanSummary extends PlanHeader {
  week_count: number;
  outcome_count: number;
}

export interface TermPlanView extends PlanHeader, PlanPermissions {
  notes: string | null;
  weeks: {
    week_number: number;
    starts_on: string | null;
    unit: string | null;
    notes: string | null;
    outcomes: PlanOutcome[];
  }[];
}

async function termPlanHeaders(
  tx: TransactionSql,
  schoolId: string,
  where: Fragment,
): Promise<TermPlanRow[]> {
  const settings = await getPlanningSettings(tx, schoolId);
  return tx<TermPlanRow[]>`
    SELECT ${headerColumns(tx, termDueOn(tx, settings.term_plan_due_days))}, plan.notes,
           (SELECT count(*)::int FROM app.term_plan_weeks AS week
             WHERE week.term_plan_id = plan.id AND week.school_id = plan.school_id) AS week_count,
           (SELECT count(DISTINCT covered.outcome_id)::int
              FROM app.term_plan_weeks AS week
              JOIN app.term_plan_week_outcomes AS covered
                ON covered.week_id = week.id AND covered.school_id = week.school_id
             WHERE week.term_plan_id = plan.id AND week.school_id = plan.school_id) AS outcome_count
    FROM app.term_plans AS plan
    ${headerJoins(tx)}
    WHERE plan.school_id = ${schoolId}::uuid ${where}
  `;
}

type TermPlanRow = PlanHeaderRow & {
  week_count: number;
  outcome_count: number;
  notes: string | null;
};

function termSummary(row: TermPlanRow): TermPlanSummary {
  const { notes: _notes, week_count, outcome_count, ...header } = row;
  return { ...toHeader(header), week_count, outcome_count };
}

export async function listTermPlans(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
): Promise<{ section_id: string; subject_id: string; plans: TermPlanSummary[] }> {
  await assertCanReadSectionSubject(tx, sectionId, subjectId);
  const rows = await termPlanHeaders(
    tx,
    schoolId,
    tx`AND plan.section_id = ${sectionId}::uuid AND plan.subject_id = ${subjectId}::uuid
       ORDER BY term.sequence_number`,
  );
  return {
    section_id: sectionId,
    subject_id: subjectId,
    plans: rows.map(termSummary),
  };
}

async function requireTermPlanRow(tx: TransactionSql, schoolId: string, planId: string) {
  const [row] = await termPlanHeaders(tx, schoolId, tx`AND plan.id = ${planId}::uuid`);
  return row ?? notFound("Term plan");
}

export async function getTermPlan(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  planId: string,
): Promise<TermPlanView> {
  const row = await requireTermPlanRow(tx, schoolId, planId);
  const access = await planAccess(tx, row.section_id, row.subject_id);
  const weeks = await tx<
    {
      id: string;
      week_number: number;
      starts_on: string | null;
      unit: string | null;
      notes: string | null;
      outcome_ids: string[];
    }[]
  >`
    SELECT week.id, week.week_number, week.starts_on::text AS starts_on, week.unit, week.notes,
           coalesce(
             array_agg(covered.outcome_id) FILTER (WHERE covered.outcome_id IS NOT NULL),
             '{}'
           )::text[] AS outcome_ids
    FROM app.term_plan_weeks AS week
    LEFT JOIN app.term_plan_week_outcomes AS covered
      ON covered.week_id = week.id AND covered.school_id = week.school_id
    WHERE week.school_id = ${schoolId}::uuid AND week.term_plan_id = ${planId}::uuid
    GROUP BY week.id
    ORDER BY week.week_number
  `;
  const byId = await outcomesById(
    tx,
    schoolId,
    weeks.flatMap((week) => week.outcome_ids),
  );
  const { week_count: _w, outcome_count: _o, notes, ...header } = row;
  return {
    ...toHeader(header),
    ...permissionsFor(access, row, userId),
    notes,
    weeks: weeks.map((week) => ({
      week_number: week.week_number,
      starts_on: week.starts_on,
      unit: week.unit,
      notes: week.notes,
      outcomes: ordered(week.outcome_ids, byId),
    })),
  };
}

function validateWeeks(weeks: readonly TermPlanWeekInput[]): void {
  if (weeks.length > TERM_PLAN_WEEKS_MAX)
    invalid(`A term plan has at most ${TERM_PLAN_WEEKS_MAX} weeks`);
  assertDistinct(
    weeks.map((week) => String(week.week_number)),
    "week number",
  );
  for (const week of weeks) assertDistinct(week.outcome_ids, "outcome in a week");
}

async function writeWeeks(
  tx: TransactionSql,
  schoolId: string,
  planId: string,
  weeks: readonly TermPlanWeekInput[],
): Promise<void> {
  await tx`
    DELETE FROM app.term_plan_weeks
    WHERE school_id = ${schoolId}::uuid AND term_plan_id = ${planId}::uuid
  `;
  for (const week of weeks) {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.term_plan_weeks (school_id, term_plan_id, week_number, starts_on, unit, notes)
      VALUES (
        ${schoolId}::uuid, ${planId}::uuid, ${week.week_number}, ${week.starts_on ?? null}::date,
        ${clean(week.unit)}, ${clean(week.notes)}
      )
      RETURNING id
    `;
    if (week.outcome_ids.length > 0) {
      await tx`
        INSERT INTO app.term_plan_week_outcomes (school_id, week_id, outcome_id)
        SELECT ${schoolId}::uuid, ${row!.id}::uuid, outcome_id
        FROM unnest(${week.outcome_ids}::uuid[]) AS outcome_id
      `;
    }
  }
}

export async function createTermPlan(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sectionId: string,
  subjectId: string,
  input: TermPlanInput & { term_id: string },
): Promise<TermPlanView> {
  await assertTeaches(tx, sectionId, subjectId);
  const section = await requireSectionSubject(tx, schoolId, sectionId, subjectId);
  const [term] = await tx<{ id: string }[]>`
    SELECT id FROM app.terms
    WHERE id = ${input.term_id}::uuid AND school_id = ${schoolId}::uuid
      AND academic_year_id = ${section.academic_year_id}::uuid
  `;
  if (!term) notFound("Term");
  validateWeeks(input.weeks);
  await assertOutcomes(
    tx,
    schoolId,
    subjectId,
    section.grade_level_id,
    input.weeks.flatMap((week) => week.outcome_ids),
  );
  const [existing] = await tx<{ id: string }[]>`
    SELECT id FROM app.term_plans
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
      AND subject_id = ${subjectId}::uuid AND term_id = ${input.term_id}::uuid
  `;
  if (existing) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_DUPLICATE_ENTRY,
      "This subject already has a plan for this term in this section",
    );
  }
  const [plan] = await tx<{ id: string }[]>`
    INSERT INTO app.term_plans (
      school_id, academic_year_id, term_id, section_id, subject_id, author_user_id, notes
    ) VALUES (
      ${schoolId}::uuid, ${section.academic_year_id}::uuid, ${input.term_id}::uuid,
      ${sectionId}::uuid, ${subjectId}::uuid, ${userId}::uuid, ${clean(input.notes)}
    )
    RETURNING id
  `;
  await writeWeeks(tx, schoolId, plan!.id, input.weeks);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "term_plans",
    targetId: plan!.id,
    newValues: {
      section_id: sectionId,
      subject_id: subjectId,
      term_id: input.term_id,
      weeks: input.weeks.length,
    },
  });
  return getTermPlan(tx, schoolId, userId, plan!.id);
}

export async function updateTermPlan(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  planId: string,
  input: TermPlanInput,
): Promise<TermPlanView> {
  const row = await requireTermPlanRow(tx, schoolId, planId);
  await assertTeaches(tx, row.section_id, row.subject_id);
  if (row.status !== "draft" && row.status !== "returned") {
    wrongState(`A ${row.status} plan can no longer be edited`);
  }
  validateWeeks(input.weeks);
  await assertOutcomes(
    tx,
    schoolId,
    row.subject_id,
    row.grade_level_id,
    input.weeks.flatMap((week) => week.outcome_ids),
  );
  await tx`
    UPDATE app.term_plans
    SET notes = ${clean(input.notes)}, updated_at = GREATEST(CURRENT_TIMESTAMP, created_at)
    WHERE id = ${planId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await writeWeeks(tx, schoolId, planId, input.weeks);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "term_plans",
    targetId: planId,
    oldValues: { notes: row.notes, weeks: row.week_count },
    newValues: { notes: clean(input.notes), weeks: input.weeks.length },
  });
  return getTermPlan(tx, schoolId, userId, planId);
}

export async function deleteTermPlan(
  tx: TransactionSql,
  schoolId: string,
  planId: string,
): Promise<void> {
  const row = await requireTermPlanRow(tx, schoolId, planId);
  await assertTeaches(tx, row.section_id, row.subject_id);
  if (row.status !== "draft") wrongState("Only a draft plan can be deleted");
  await tx`DELETE FROM app.term_plans WHERE id = ${planId}::uuid AND school_id = ${schoolId}::uuid`;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "term_plans",
    targetId: planId,
    oldValues: { section_id: row.section_id, subject_id: row.subject_id, term_id: row.term_id },
  });
}

// ---------------------------------------------------------------------------
// Submit and review (both kinds)
// ---------------------------------------------------------------------------

type PlanTable = "term_plans" | "lesson_plans";

async function submitPlan(
  tx: TransactionSql,
  schoolId: string,
  table: PlanTable,
  row: { id: string; section_id: string; subject_id: string; status: PlanStatus },
): Promise<void> {
  await assertTeaches(tx, row.section_id, row.subject_id);
  if (row.status !== "draft" && row.status !== "returned") {
    wrongState(`A ${row.status} plan cannot be submitted`);
  }
  await tx`
    UPDATE ${tx(`app.${table}`)}
    SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
        first_submitted_at = coalesce(first_submitted_at, CURRENT_TIMESTAMP),
        updated_at = GREATEST(CURRENT_TIMESTAMP, created_at)
    WHERE id = ${row.id}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: table,
    targetId: row.id,
    oldValues: { status: row.status },
    newValues: { status: "submitted" },
  });
}

export interface ReviewInput {
  decision: ReviewDecision;
  comment?: string | null;
}

async function reviewPlan(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  table: PlanTable,
  row: {
    id: string;
    academic_year_id: string;
    section_id: string;
    subject_id: string;
    author_user_id: string;
    status: PlanStatus;
  },
  input: ReviewInput,
): Promise<void> {
  // Leadership, or the subject's coordinator for the section's grade; everyone else 403.
  await assertCoordinatesSubject(tx, row.subject_id, row.academic_year_id, row.section_id);
  if (row.author_user_id === userId) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "A plan is reviewed by someone other than its author",
    );
  }
  if (row.status !== "submitted") wrongState(`A ${row.status} plan is not awaiting review`);
  const comment = clean(input.comment);
  if (input.decision === "return" && comment === null) {
    invalid("Say what to change when returning a plan");
  }
  const status: PlanStatus = input.decision === "approve" ? "approved" : "returned";
  await tx`
    UPDATE ${tx(`app.${table}`)}
    SET status = ${status}, reviewed_at = CURRENT_TIMESTAMP, reviewed_by_user_id = ${userId}::uuid,
        review_comment = ${comment}, updated_at = GREATEST(CURRENT_TIMESTAMP, created_at)
    WHERE id = ${row.id}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: table,
    targetId: row.id,
    oldValues: { status: row.status },
    newValues: { status, review_comment: comment, reviewed_by_user_id: userId },
  });
}

export async function submitTermPlan(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  planId: string,
): Promise<TermPlanView> {
  await submitPlan(tx, schoolId, "term_plans", await requireTermPlanRow(tx, schoolId, planId));
  return getTermPlan(tx, schoolId, userId, planId);
}

export async function reviewTermPlan(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  planId: string,
  input: ReviewInput,
): Promise<TermPlanView> {
  const row = await requireTermPlanRow(tx, schoolId, planId);
  await reviewPlan(tx, schoolId, userId, "term_plans", row, input);
  return getTermPlan(tx, schoolId, userId, planId);
}

// ---------------------------------------------------------------------------
// Lesson plans
// ---------------------------------------------------------------------------

export interface LessonPlanInput {
  lesson_date: string;
  period?: number | null;
  title: string;
  objectives?: string | null;
  activities?: string | null;
  resources?: string | null;
  homework?: string | null;
  outcome_ids: string[];
  material_ids: string[];
}

interface LessonRow extends PlanHeaderRow {
  lesson_date: string;
  period: number | null;
  title: string;
  objectives: string | null;
  activities: string | null;
  resources: string | null;
  homework: string | null;
  reflection: string | null;
  outcome_count: number;
}

export interface LessonPlanSummary extends PlanHeader {
  lesson_date: string;
  period: number | null;
  title: string;
  outcome_count: number;
}

export interface LessonPlanView extends PlanHeader, PlanPermissions {
  lesson_date: string;
  period: number | null;
  title: string;
  objectives: string | null;
  activities: string | null;
  resources: string | null;
  homework: string | null;
  reflection: string | null;
  can_reflect: boolean;
  outcomes: PlanOutcome[];
  materials: { id: string; title: string }[];
}

async function lessonRows(
  tx: TransactionSql,
  schoolId: string,
  where: Fragment,
): Promise<LessonRow[]> {
  const settings = await getPlanningSettings(tx, schoolId);
  return tx<LessonRow[]>`
    SELECT ${headerColumns(tx, lessonDueOn(tx, settings.lesson_plan_lead_days))},
           plan.lesson_date::text AS lesson_date, plan.period, plan.title, plan.objectives,
           plan.activities, plan.resources, plan.homework, plan.reflection,
           (SELECT count(*)::int FROM app.lesson_plan_outcomes AS covered
             WHERE covered.lesson_plan_id = plan.id AND covered.school_id = plan.school_id)
             AS outcome_count
    FROM app.lesson_plans AS plan
    ${headerJoins(tx)}
    WHERE plan.school_id = ${schoolId}::uuid ${where}
  `;
}

function lessonSummary(row: LessonRow): LessonPlanSummary {
  const {
    objectives: _objectives,
    activities: _activities,
    resources: _resources,
    homework: _homework,
    reflection: _reflection,
    lesson_date,
    period,
    title,
    outcome_count,
    ...header
  } = row;
  return { ...toHeader(header), lesson_date, period, title, outcome_count };
}

export async function listLessonPlans(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
  range: { from?: string; to?: string },
): Promise<{ section_id: string; subject_id: string; plans: LessonPlanSummary[] }> {
  await assertCanReadSectionSubject(tx, sectionId, subjectId);
  const rows = await lessonRows(
    tx,
    schoolId,
    tx`AND plan.section_id = ${sectionId}::uuid AND plan.subject_id = ${subjectId}::uuid
       ${range.from ? tx`AND plan.lesson_date >= ${range.from}::date` : tx``}
       ${range.to ? tx`AND plan.lesson_date <= ${range.to}::date` : tx``}
       ORDER BY plan.lesson_date DESC, plan.period NULLS LAST, plan.created_at DESC
       LIMIT ${LIST_LIMIT}`,
  );
  return { section_id: sectionId, subject_id: subjectId, plans: rows.map(lessonSummary) };
}

async function requireLessonRow(tx: TransactionSql, schoolId: string, planId: string) {
  const [row] = await lessonRows(tx, schoolId, tx`AND plan.id = ${planId}::uuid`);
  return row ?? notFound("Lesson plan");
}

export async function getLessonPlan(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  planId: string,
): Promise<LessonPlanView> {
  const row = await requireLessonRow(tx, schoolId, planId);
  const access = await planAccess(tx, row.section_id, row.subject_id);
  const [links] = await tx<{ outcome_ids: string[]; materials: { id: string; title: string }[] }[]>`
    SELECT
      coalesce(
        (SELECT array_agg(outcome_id) FROM app.lesson_plan_outcomes
          WHERE school_id = ${schoolId}::uuid AND lesson_plan_id = ${planId}::uuid),
        '{}'
      )::text[] AS outcome_ids,
      coalesce(
        (SELECT json_agg(json_build_object('id', material_id, 'title', title) ORDER BY title)
           FROM app.lesson_plan_materials
          WHERE school_id = ${schoolId}::uuid AND lesson_plan_id = ${planId}::uuid),
        '[]'::json
      ) AS materials
  `;
  const byId = await outcomesById(tx, schoolId, links!.outcome_ids);
  const { outcome_count: _count, ...rest } = row;
  const {
    lesson_date,
    period,
    title,
    objectives,
    activities,
    resources,
    homework,
    reflection,
    ...header
  } = rest;
  return {
    ...toHeader(header),
    ...permissionsFor(access, row, userId),
    lesson_date,
    period,
    title,
    objectives,
    activities,
    resources,
    homework,
    reflection,
    can_reflect: access.teaches,
    outcomes: ordered(links!.outcome_ids, byId),
    materials: links!.materials,
  };
}

/** The class materials of the section's subject, by id: what a lesson may link. */
async function sectionMaterials(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
  ids?: readonly string[],
): Promise<{ id: string; title: string }[]> {
  return tx<{ id: string; title: string }[]>`
    SELECT material.id, material.title
    FROM app.materials AS material
    JOIN app.classes AS class
      ON class.id = material.class_id AND class.school_id = material.school_id
    JOIN app.courses AS course
      ON course.id = class.course_id AND course.school_id = class.school_id
    WHERE material.school_id = ${schoolId}::uuid
      AND class.section_id = ${sectionId}::uuid
      AND course.subject_id = ${subjectId}::uuid
      ${ids ? tx`AND material.id = ANY (${[...ids]}::uuid[])` : tx``}
    ORDER BY material.created_at DESC
    LIMIT ${LIST_LIMIT}
  `;
}

interface CleanLesson {
  lesson_date: string;
  period: number | null;
  title: string;
  objectives: string | null;
  activities: string | null;
  resources: string | null;
  homework: string | null;
  term_id: string | null;
  materials: { id: string; title: string }[];
}

async function validateLesson(
  tx: TransactionSql,
  schoolId: string,
  section: SectionRow,
  subjectId: string,
  input: LessonPlanInput,
): Promise<CleanLesson> {
  const title = clean(input.title) ?? invalid("The lesson needs a title");
  const year = await requireYear(tx, schoolId, section.academic_year_id);
  const date = input.lesson_date;
  const [inYear] = await tx<{ inside: boolean; term_id: string | null }[]>`
    SELECT ${date}::date BETWEEN ${year.starts_on}::date AND ${year.ends_on}::date AS inside,
           (SELECT id FROM app.terms
             WHERE school_id = ${schoolId}::uuid
               AND academic_year_id = ${section.academic_year_id}::uuid
               AND ${date}::date BETWEEN starts_on AND ends_on
             ORDER BY sequence_number LIMIT 1) AS term_id
  `;
  if (!inYear?.inside) invalid(`The lesson date is outside the ${year.name} academic year`);
  assertDistinct(input.outcome_ids, "outcome");
  assertDistinct(input.material_ids, "material");
  await assertOutcomes(tx, schoolId, subjectId, section.grade_level_id, input.outcome_ids);
  const materials =
    input.material_ids.length === 0
      ? []
      : await sectionMaterials(tx, schoolId, section.id, subjectId, input.material_ids);
  if (materials.length !== input.material_ids.length) {
    invalid("A material is not one of this class's uploaded materials");
  }
  return {
    lesson_date: date,
    period: input.period ?? null,
    title,
    objectives: clean(input.objectives),
    activities: clean(input.activities),
    resources: clean(input.resources),
    homework: clean(input.homework),
    term_id: inYear.term_id,
    materials,
  };
}

async function writeLessonLinks(
  tx: TransactionSql,
  schoolId: string,
  planId: string,
  outcomeIds: readonly string[],
  materials: readonly { id: string; title: string }[],
): Promise<void> {
  await tx`
    DELETE FROM app.lesson_plan_outcomes
    WHERE school_id = ${schoolId}::uuid AND lesson_plan_id = ${planId}::uuid
  `;
  await tx`
    DELETE FROM app.lesson_plan_materials
    WHERE school_id = ${schoolId}::uuid AND lesson_plan_id = ${planId}::uuid
  `;
  if (outcomeIds.length > 0) {
    await tx`
      INSERT INTO app.lesson_plan_outcomes (school_id, lesson_plan_id, outcome_id)
      SELECT ${schoolId}::uuid, ${planId}::uuid, outcome_id
      FROM unnest(${[...outcomeIds]}::uuid[]) AS outcome_id
    `;
  }
  if (materials.length > 0) {
    await tx`
      INSERT INTO app.lesson_plan_materials (school_id, lesson_plan_id, material_id, title)
      SELECT ${schoolId}::uuid, ${planId}::uuid, x.id, x.title
      FROM jsonb_to_recordset(${tx.json(materials as never)}::jsonb) AS x(id uuid, title text)
    `;
  }
}

export async function createLessonPlan(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sectionId: string,
  subjectId: string,
  input: LessonPlanInput,
): Promise<LessonPlanView> {
  await assertTeaches(tx, sectionId, subjectId);
  const section = await requireSectionSubject(tx, schoolId, sectionId, subjectId);
  const lesson = await validateLesson(tx, schoolId, section, subjectId, input);
  const [plan] = await tx<{ id: string }[]>`
    INSERT INTO app.lesson_plans (
      school_id, academic_year_id, term_id, section_id, subject_id, author_user_id, lesson_date,
      period, title, objectives, activities, resources, homework
    ) VALUES (
      ${schoolId}::uuid, ${section.academic_year_id}::uuid, ${lesson.term_id}::uuid,
      ${sectionId}::uuid, ${subjectId}::uuid, ${userId}::uuid, ${lesson.lesson_date}::date,
      ${lesson.period}, ${lesson.title}, ${lesson.objectives}, ${lesson.activities},
      ${lesson.resources}, ${lesson.homework}
    )
    RETURNING id
  `;
  await writeLessonLinks(tx, schoolId, plan!.id, input.outcome_ids, lesson.materials);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "lesson_plans",
    targetId: plan!.id,
    newValues: {
      section_id: sectionId,
      subject_id: subjectId,
      lesson_date: lesson.lesson_date,
      period: lesson.period,
      title: lesson.title,
    },
  });
  return getLessonPlan(tx, schoolId, userId, plan!.id);
}

export async function updateLessonPlan(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  planId: string,
  input: LessonPlanInput,
): Promise<LessonPlanView> {
  const row = await requireLessonRow(tx, schoolId, planId);
  await assertTeaches(tx, row.section_id, row.subject_id);
  if (row.status !== "draft" && row.status !== "returned") {
    wrongState(`A ${row.status} plan can no longer be edited`);
  }
  const section = await requireSectionRow(tx, schoolId, row.section_id);
  const lesson = await validateLesson(tx, schoolId, section, row.subject_id, input);
  await tx`
    UPDATE app.lesson_plans
    SET term_id = ${lesson.term_id}::uuid, lesson_date = ${lesson.lesson_date}::date,
        period = ${lesson.period}, title = ${lesson.title}, objectives = ${lesson.objectives},
        activities = ${lesson.activities}, resources = ${lesson.resources},
        homework = ${lesson.homework}, updated_at = GREATEST(CURRENT_TIMESTAMP, created_at)
    WHERE id = ${planId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await writeLessonLinks(tx, schoolId, planId, input.outcome_ids, lesson.materials);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "lesson_plans",
    targetId: planId,
    oldValues: { lesson_date: row.lesson_date, period: row.period, title: row.title },
    newValues: { lesson_date: lesson.lesson_date, period: lesson.period, title: lesson.title },
  });
  return getLessonPlan(tx, schoolId, userId, planId);
}

/** The teacher's reflection after the lesson: allowed in any status. */
export async function saveLessonReflection(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  planId: string,
  reflection: string | null,
): Promise<LessonPlanView> {
  const row = await requireLessonRow(tx, schoolId, planId);
  await assertTeaches(tx, row.section_id, row.subject_id);
  const next = clean(reflection);
  await tx`
    UPDATE app.lesson_plans
    SET reflection = ${next}, updated_at = GREATEST(CURRENT_TIMESTAMP, created_at)
    WHERE id = ${planId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "lesson_plans",
    targetId: planId,
    oldValues: { reflection: row.reflection },
    newValues: { reflection: next },
  });
  return getLessonPlan(tx, schoolId, userId, planId);
}

export async function deleteLessonPlan(
  tx: TransactionSql,
  schoolId: string,
  planId: string,
): Promise<void> {
  const row = await requireLessonRow(tx, schoolId, planId);
  await assertTeaches(tx, row.section_id, row.subject_id);
  if (row.status !== "draft") wrongState("Only a draft plan can be deleted");
  await tx`DELETE FROM app.lesson_plans WHERE id = ${planId}::uuid AND school_id = ${schoolId}::uuid`;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "lesson_plans",
    targetId: planId,
    oldValues: {
      section_id: row.section_id,
      subject_id: row.subject_id,
      lesson_date: row.lesson_date,
      title: row.title,
    },
  });
}

export async function submitLessonPlan(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  planId: string,
): Promise<LessonPlanView> {
  await submitPlan(tx, schoolId, "lesson_plans", await requireLessonRow(tx, schoolId, planId));
  return getLessonPlan(tx, schoolId, userId, planId);
}

export async function reviewLessonPlan(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  planId: string,
  input: ReviewInput,
): Promise<LessonPlanView> {
  const row = await requireLessonRow(tx, schoolId, planId);
  await reviewPlan(tx, schoolId, userId, "lesson_plans", row, input);
  return getLessonPlan(tx, schoolId, userId, planId);
}

export interface LessonPlanOptions {
  lesson_date: string | null;
  /** The live timetable's periods for this section's subject on that date. */
  periods: number[];
  materials: { id: string; title: string }[];
  outcomes: PlanOutcome[];
}

/** What a lesson plan picks from: the date's timetable periods, materials and outcomes. */
export async function getLessonPlanOptions(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
  date: string | undefined,
): Promise<LessonPlanOptions> {
  await assertCanReadSectionSubject(tx, sectionId, subjectId);
  const section = await requireSectionSubject(tx, schoolId, sectionId, subjectId);
  const periods = date
    ? await tx<{ period: number }[]>`
        SELECT DISTINCT slot.period
        FROM app.timetable_slots AS slot
        JOIN app.timetable_versions AS version
          ON version.id = slot.timetable_version_id AND version.school_id = slot.school_id
         AND version.status = 'approved'
        JOIN app.terms AS term
          ON term.id = version.term_id AND term.school_id = version.school_id
         AND ${date}::date BETWEEN term.starts_on AND term.ends_on
        JOIN app.classes AS class ON class.id = slot.class_id AND class.school_id = slot.school_id
        JOIN app.courses AS course
          ON course.id = class.course_id AND course.school_id = class.school_id
        WHERE slot.school_id = ${schoolId}::uuid
          AND class.section_id = ${sectionId}::uuid
          AND course.subject_id = ${subjectId}::uuid
          AND slot.weekday = EXTRACT(ISODOW FROM ${date}::date)::smallint
        ORDER BY slot.period
      `
    : [];
  const outcomes = await tx<PlanOutcome[]>`
    SELECT id, code, text, text_ar, strand FROM app.learning_outcomes
    WHERE school_id = ${schoolId}::uuid AND subject_id = ${subjectId}::uuid
      AND grade_level_id = ${section.grade_level_id}::uuid AND archived_at IS NULL
    ORDER BY sort_order, code
  `;
  return {
    lesson_date: date ?? null,
    periods: periods.map((row) => row.period),
    materials: await sectionMaterials(tx, schoolId, sectionId, subjectId),
    outcomes,
  };
}

// ---------------------------------------------------------------------------
// Review queue and coverage
// ---------------------------------------------------------------------------

/** The year asked for, or the latest active or finalized one. */
async function resolveYearId(
  tx: TransactionSql,
  schoolId: string,
  yearId: string | undefined,
): Promise<string | null> {
  if (yearId) return (await requireYear(tx, schoolId, yearId)).id;
  const [latest] = await tx<{ id: string }[]>`
    SELECT id FROM app.academic_years
    WHERE school_id = ${schoolId}::uuid AND grading_config_status IN ('active', 'finalized')
    ORDER BY starts_on DESC LIMIT 1
  `;
  return latest?.id ?? null;
}

async function isLeadership(tx: TransactionSql): Promise<boolean> {
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT app.current_user_is_school_admin() AS allowed
  `;
  return row?.allowed === true;
}

/** Plans the caller reviews: leadership every one, a coordinator their subjects' sections. */
function reviewableFilter(tx: TransactionSql, leadership: boolean) {
  return leadership
    ? tx``
    : tx`AND app.coordinates_section_subject(plan.section_id, plan.subject_id)`;
}

export interface PlanReviewQueue {
  academic_year_id: string | null;
  status: PlanStatus;
  term_plans: (TermPlanSummary & { can_review: boolean })[];
  lesson_plans: (LessonPlanSummary & { can_review: boolean })[];
}

export async function listPlanReviews(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  query: { yearId?: string; status?: PlanStatus },
): Promise<PlanReviewQueue> {
  const status = query.status ?? "submitted";
  const yearId = await resolveYearId(tx, schoolId, query.yearId);
  if (!yearId) return { academic_year_id: null, status, term_plans: [], lesson_plans: [] };
  const leadership = await isLeadership(tx);
  const filter = tx`
    AND plan.academic_year_id = ${yearId}::uuid AND plan.status = ${status}
    ${reviewableFilter(tx, leadership)}
  `;
  const [terms, lessons] = await Promise.all([
    termPlanHeaders(
      tx,
      schoolId,
      tx`${filter} ORDER BY plan.submitted_at NULLS LAST, plan.created_at LIMIT ${LIST_LIMIT}`,
    ),
    lessonRows(
      tx,
      schoolId,
      tx`${filter} ORDER BY plan.lesson_date, plan.period NULLS LAST LIMIT ${LIST_LIMIT}`,
    ),
  ]);
  const canReview = (row: { status: PlanStatus; author_user_id: string }) =>
    row.status === "submitted" && row.author_user_id !== userId;
  return {
    academic_year_id: yearId,
    status,
    term_plans: terms.map((row) => ({
      ...termSummary(row),
      can_review: canReview(row),
    })),
    lesson_plans: lessons.map((row) => ({ ...lessonSummary(row), can_review: canReview(row) })),
  };
}

export interface PlanCoverageRow {
  section_id: string;
  section_name: string;
  grade_level_name: string;
  subject_id: string;
  subject_name: string;
  teacher_names: string[];
  term_plan: {
    id: string;
    status: PlanStatus;
    submitted_at: string | null;
    on_time: boolean | null;
  } | null;
  /** The day the term plan is due. */
  term_plan_due_on: string;
  lesson_plans: {
    total: number;
    draft: number;
    submitted: number;
    approved: number;
    returned: number;
    /** First submitted by the lesson's due day. */
    on_time: number;
    /** First submitted after it. */
    late: number;
    /** Still a draft past its due day. */
    overdue: number;
  };
  outcomes: { total: number; covered: number };
}

export interface PlanCoverage {
  academic_year_id: string;
  term_id: string;
  term_name: string;
  rows: PlanCoverageRow[];
}

/**
 * Plan coverage for a term, per section and subject taught: the term plan and whether it came in
 * on time, lesson plans by status and timeliness, and how many of the grade's active outcomes the
 * submitted plans cover. Leadership sees every section; a coordinator their subjects'.
 */
export async function getPlanCoverage(
  tx: TransactionSql,
  schoolId: string,
  termId: string,
): Promise<PlanCoverage> {
  const [term] = await tx<
    { id: string; name: string; academic_year_id: string; starts_on: string }[]
  >`
    SELECT id, name, academic_year_id, starts_on::text AS starts_on FROM app.terms
    WHERE id = ${termId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!term) notFound("Term");
  const settings = await getPlanningSettings(tx, schoolId);
  const leadership = await isLeadership(tx);
  const pairFilter = leadership
    ? tx``
    : tx`WHERE app.coordinates_section_subject(pair.section_id, pair.subject_id)`;

  const pairs = await tx<
    {
      section_id: string;
      section_name: string;
      grade_level_id: string;
      grade_level_name: string;
      subject_id: string;
      subject_name: string;
      teacher_names: string[];
      term_plan_due_on: string;
    }[]
  >`
    WITH pair AS (
      SELECT section_id, subject_id FROM app.section_subject_teachers
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${term.academic_year_id}::uuid
      UNION
      SELECT section_id, subject_id FROM app.term_plans
      WHERE school_id = ${schoolId}::uuid AND term_id = ${termId}::uuid
      UNION
      SELECT section_id, subject_id FROM app.lesson_plans
      WHERE school_id = ${schoolId}::uuid AND term_id = ${termId}::uuid
    )
    SELECT pair.section_id, section.name AS section_name, section.grade_level_id,
           grade.name AS grade_level_name, pair.subject_id, subject.name AS subject_name,
           coalesce(
             ARRAY(
               SELECT DISTINCT users.display_name
               FROM app.section_subject_teachers AS assignment
               JOIN app.teachers AS teacher
                 ON teacher.id = assignment.teacher_id AND teacher.school_id = assignment.school_id
               JOIN app.users AS users
                 ON users.id = teacher.user_id AND users.school_id = teacher.school_id
               WHERE assignment.school_id = ${schoolId}::uuid
                 AND assignment.section_id = pair.section_id
                 AND assignment.subject_id = pair.subject_id
               ORDER BY users.display_name
             ),
             '{}'
           )::text[] AS teacher_names,
           (${term.starts_on}::date + ${settings.term_plan_due_days}::int)::text AS term_plan_due_on
    FROM pair
    JOIN app.sections AS section
      ON section.id = pair.section_id AND section.school_id = ${schoolId}::uuid
    JOIN app.grade_levels AS grade
      ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    JOIN app.subjects AS subject
      ON subject.id = pair.subject_id AND subject.school_id = ${schoolId}::uuid
    ${pairFilter}
    ORDER BY grade.sort_order, grade.name, section.name, subject.name
  `;
  if (pairs.length === 0) {
    return {
      academic_year_id: term.academic_year_id,
      term_id: termId,
      term_name: term.name,
      rows: [],
    };
  }

  const termPlans = await termPlanHeaders(tx, schoolId, tx`AND plan.term_id = ${termId}::uuid`);
  const lessonCounts = await tx<
    {
      section_id: string;
      subject_id: string;
      total: number;
      draft: number;
      submitted: number;
      approved: number;
      returned: number;
      on_time: number;
      late: number;
      overdue: number;
    }[]
  >`
    WITH lesson AS (
      SELECT plan.section_id, plan.subject_id, plan.status,
             plan.lesson_date - ${settings.lesson_plan_lead_days}::int AS due_on,
             (plan.first_submitted_at AT TIME ZONE
               coalesce(school_settings.timezone, ${DEFAULT_TIMEZONE}))::date AS first_submitted_on,
             (CURRENT_TIMESTAMP AT TIME ZONE
               coalesce(school_settings.timezone, ${DEFAULT_TIMEZONE}))::date AS today
      FROM app.lesson_plans AS plan
      LEFT JOIN app.school_settings AS school_settings ON school_settings.school_id = plan.school_id
      WHERE plan.school_id = ${schoolId}::uuid AND plan.term_id = ${termId}::uuid
    )
    SELECT section_id, subject_id, count(*)::int AS total,
           count(*) FILTER (WHERE status = 'draft')::int AS draft,
           count(*) FILTER (WHERE status = 'submitted')::int AS submitted,
           count(*) FILTER (WHERE status = 'approved')::int AS approved,
           count(*) FILTER (WHERE status = 'returned')::int AS returned,
           count(*) FILTER (WHERE first_submitted_on <= due_on)::int AS on_time,
           count(*) FILTER (WHERE first_submitted_on > due_on)::int AS late,
           count(*) FILTER (WHERE first_submitted_on IS NULL AND today > due_on)::int AS overdue
    FROM lesson
    GROUP BY section_id, subject_id
  `;
  const outcomeTotals = await tx<{ subject_id: string; grade_level_id: string; total: number }[]>`
    SELECT subject_id, grade_level_id, count(*)::int AS total FROM app.learning_outcomes
    WHERE school_id = ${schoolId}::uuid AND archived_at IS NULL
    GROUP BY subject_id, grade_level_id
  `;
  // Outcomes named by a submitted (not draft) term plan week or lesson plan of the term.
  const covered = await tx<{ section_id: string; subject_id: string; covered: number }[]>`
    SELECT named.section_id, named.subject_id, count(DISTINCT named.outcome_id)::int AS covered
    FROM (
      SELECT plan.section_id, plan.subject_id, link.outcome_id
      FROM app.term_plans AS plan
      JOIN app.term_plan_weeks AS week
        ON week.term_plan_id = plan.id AND week.school_id = plan.school_id
      JOIN app.term_plan_week_outcomes AS link
        ON link.week_id = week.id AND link.school_id = week.school_id
      WHERE plan.school_id = ${schoolId}::uuid AND plan.term_id = ${termId}::uuid
        AND plan.status <> 'draft'
      UNION ALL
      SELECT plan.section_id, plan.subject_id, link.outcome_id
      FROM app.lesson_plans AS plan
      JOIN app.lesson_plan_outcomes AS link
        ON link.lesson_plan_id = plan.id AND link.school_id = plan.school_id
      WHERE plan.school_id = ${schoolId}::uuid AND plan.term_id = ${termId}::uuid
        AND plan.status <> 'draft'
    ) AS named
    JOIN app.learning_outcomes AS outcome
      ON outcome.id = named.outcome_id AND outcome.school_id = ${schoolId}::uuid
     AND outcome.archived_at IS NULL
    GROUP BY named.section_id, named.subject_id
  `;

  const pairKey = (sectionId: string, subjectId: string) => `${sectionId}|${subjectId}`;
  const planBy = new Map(termPlans.map((row) => [pairKey(row.section_id, row.subject_id), row]));
  const lessonsBy = new Map(
    lessonCounts.map((row) => [pairKey(row.section_id, row.subject_id), row]),
  );
  const totalBy = new Map(
    outcomeTotals.map((row) => [`${row.subject_id}|${row.grade_level_id}`, row.total]),
  );
  const coveredBy = new Map(
    covered.map((row) => [pairKey(row.section_id, row.subject_id), row.covered]),
  );
  const empty = {
    total: 0,
    draft: 0,
    submitted: 0,
    approved: 0,
    returned: 0,
    on_time: 0,
    late: 0,
    overdue: 0,
  };

  return {
    academic_year_id: term.academic_year_id,
    term_id: termId,
    term_name: term.name,
    rows: pairs.map((pair) => {
      const key = pairKey(pair.section_id, pair.subject_id);
      const plan = planBy.get(key);
      const lessons = lessonsBy.get(key);
      return {
        section_id: pair.section_id,
        section_name: pair.section_name,
        grade_level_name: pair.grade_level_name,
        subject_id: pair.subject_id,
        subject_name: pair.subject_name,
        teacher_names: pair.teacher_names,
        term_plan: plan
          ? {
              id: plan.id,
              status: plan.status,
              submitted_at: iso(plan.submitted_at),
              on_time: plan.on_time,
            }
          : null,
        term_plan_due_on: pair.term_plan_due_on,
        lesson_plans: lessons
          ? {
              total: lessons.total,
              draft: lessons.draft,
              submitted: lessons.submitted,
              approved: lessons.approved,
              returned: lessons.returned,
              on_time: lessons.on_time,
              late: lessons.late,
              overdue: lessons.overdue,
            }
          : { ...empty },
        outcomes: {
          total: totalBy.get(`${pair.subject_id}|${pair.grade_level_id}`) ?? 0,
          covered: coveredBy.get(key) ?? 0,
        },
      };
    }),
  };
}
