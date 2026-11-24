import { ERROR_CODES } from "@studafy/constants";
import { calculateSubjectResult } from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import {
  assertCanGradeSectionSubject,
  assertCanReadSectionSubject,
  assertConfigEditable,
  requireYear,
} from "../grading/access";
import {
  loadConfigDetails,
  loadYearConfigs,
  loadYearTerms,
  requireEffectiveSubject,
  requireSectionRow,
  rosterFrom,
  toEngineConfig,
  toMarkInputs,
} from "../grading/engine-config";
import { loadSectionsGradingData } from "../grading/results-service";

import type { GradingConfigStatus, SectionSubjectAccess } from "../grading/access";
import type { EffectiveSubject, SectionRow } from "../grading/engine-config";
import type { ErrorCode } from "@studafy/constants";
import type { PendingQuery, Row, TransactionSql } from "postgres";

/**
 * Remedial plans (000269): a plan to help a struggling student catch up in one subject, for a term
 * or the whole year.
 *
 * Who: the section's teachers of the subject open and change plans (in the mobile app); the
 * subject's coordinator (000261) and school leadership follow them up by reading them and adding
 * notes; the student and their linked parents read a plan only while the school allows sharing and
 * the plan is shared, and never an internal note. The row filters are the database's
 * (app.can_read_remedial_plan and friends, RLS); this module never widens them, and checks writers
 * with the grading module's helpers before writing.
 *
 * Suggestions: the students of a section whose current (or provisional) percentage in the subject,
 * from the marks recorded so far, is below the subject's pass percentage, worked out by the grading
 * engine in a fixed number of queries per section.
 *
 * Reviews: a plan's review dates. A review is done once someone following the plan adds a note on
 * or after its date (school time); an active plan with an earlier review not done is overdue.
 */

export const REMEDIAL_PLAN_STATUSES = ["open", "in_progress", "achieved", "closed"] as const;
export const REMEDIAL_PLAN_REASONS = ["below_pass", "teacher_concern"] as const;
export const REMEDIAL_STAFF_ACCESS = ["leadership", "teacher", "coordinator"] as const;
export const REMEDIAL_PLAN_ACCESS = [...REMEDIAL_STAFF_ACCESS, "family"] as const;

export type RemedialPlanStatus = (typeof REMEDIAL_PLAN_STATUSES)[number];
export type RemedialPlanReason = (typeof REMEDIAL_PLAN_REASONS)[number];
export type RemedialStaffAccess = (typeof REMEDIAL_STAFF_ACCESS)[number];
export type RemedialPlanAccess = (typeof REMEDIAL_PLAN_ACCESS)[number];

export const REMEDIAL_LIMITS = {
  targets: 2000,
  actions: 4000,
  reasonNote: 1000,
  note: 2000,
  reviewDates: 12,
  listMax: 500,
} as const;

const ACTIVE: readonly RemedialPlanStatus[] = ["open", "in_progress"];

/** Where each status may move. Achieved and closed are history. */
const NEXT_STATUSES: Record<RemedialPlanStatus, readonly RemedialPlanStatus[]> = {
  open: ["in_progress", "achieved", "closed"],
  in_progress: ["achieved", "closed"],
  achieved: [],
  closed: [],
};

function fail(status: 400 | 403 | 404 | 409, code: ErrorCode, message: string): never {
  throw new CodedHttpException(status, code, message);
}

/** Trimmed text, or null for blank. */
function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function required(value: string, field: string): string {
  return clean(value) ?? fail(400, ERROR_CODES.VALIDATION_FAILED, `${field} cannot be blank`);
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const num = (value: string | null): number | null => (value === null ? null : Number(value));

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface RemedialPlanSummary {
  id: string;
  academic_year_id: string;
  term_id: string | null;
  term_name: string | null;
  section_id: string;
  section_name: string;
  grade_level_id: string;
  grade_level_name: string;
  student_id: string;
  student_first_name: string;
  student_last_name: string;
  admission_number: string;
  subject_id: string;
  subject_name: string;
  reason: RemedialPlanReason;
  status: RemedialPlanStatus;
  shared_with_family: boolean;
  next_review_on: string | null;
  overdue: boolean;
  last_note_at: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface RemedialPlanDetail extends RemedialPlanSummary {
  reason_note: string | null;
  targets: string;
  actions: string;
  start_percentage: number | null;
  pass_percentage: number | null;
  reviews: { review_on: string; completed_at: string | null; overdue: boolean }[];
  notes: {
    id: string;
    kind: "note" | "status_change";
    body: string | null;
    new_status: RemedialPlanStatus | null;
    internal: boolean;
    author_name: string | null;
    author_access: RemedialStaffAccess;
    created_at: string;
  }[];
  access: RemedialPlanAccess;
  can_edit: boolean;
  can_add_note: boolean;
  family_sharing_enabled: boolean;
}

interface PlanRow {
  id: string;
  academic_year_id: string;
  year_status: GradingConfigStatus;
  term_id: string | null;
  term_name: string | null;
  section_id: string;
  section_name: string;
  grade_level_id: string;
  grade_level_name: string;
  student_id: string;
  student_first_name: string;
  student_last_name: string;
  admission_number: string;
  subject_id: string;
  subject_name: string | null;
  reason: RemedialPlanReason;
  reason_note: string | null;
  targets: string;
  actions: string;
  start_percentage: string | null;
  pass_percentage: string | null;
  status: RemedialPlanStatus;
  shared_with_family: boolean;
  next_review_on: string | null;
  overdue: boolean;
  last_note_at: Date | null;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
  staff_access: RemedialStaffAccess | null;
}

/**
 * Plans matching `where` (a fragment over `plan`), as the caller may read them (RLS). Ordered
 * overdue first, then by the next review, the student and the subject.
 */
async function loadPlanRows(
  tx: TransactionSql,
  schoolId: string,
  where: PendingQuery<Row[]>,
  limit?: number,
): Promise<PlanRow[]> {
  const limitSql = limit === undefined ? tx`` : tx`LIMIT ${limit}`;
  return tx<PlanRow[]>`
    WITH today AS (SELECT app.school_today() AS on_date)
    SELECT plan.id, plan.academic_year_id, year.grading_config_status AS year_status,
           plan.term_id, term.name AS term_name, plan.section_id, section.name AS section_name,
           section.grade_level_id, grade.name AS grade_level_name, plan.student_id,
           student.first_name AS student_first_name, student.last_name AS student_last_name,
           student.admission_number, plan.subject_id,
           app.remedial_plan_subject_name(plan.id) AS subject_name, plan.reason, plan.reason_note,
           plan.targets, plan.actions, plan.start_percentage, plan.pass_percentage, plan.status,
           plan.shared_with_family, pending.next_review_on::text AS next_review_on,
           (plan.status IN ('open', 'in_progress')
             AND pending.next_review_on IS NOT NULL
             AND pending.next_review_on < today.on_date) AS overdue,
           notes.last_note_at, creator.display_name AS created_by_name, plan.created_at,
           plan.updated_at,
           app.remedial_plan_staff_access(plan.section_id, plan.subject_id) AS staff_access
    FROM app.remedial_plans AS plan
    CROSS JOIN today
    JOIN app.academic_years AS year
      ON year.id = plan.academic_year_id AND year.school_id = plan.school_id
    JOIN app.sections AS section
      ON section.id = plan.section_id AND section.school_id = plan.school_id
    JOIN app.grade_levels AS grade
      ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    JOIN app.students AS student
      ON student.id = plan.student_id AND student.school_id = plan.school_id
    JOIN app.users AS creator
      ON creator.id = plan.created_by_user_id AND creator.school_id = plan.school_id
    LEFT JOIN app.terms AS term
      ON term.id = plan.term_id AND term.school_id = plan.school_id
    LEFT JOIN LATERAL (
      SELECT min(review.review_on) AS next_review_on
      FROM app.remedial_plan_reviews AS review
      WHERE review.school_id = plan.school_id AND review.plan_id = plan.id
        AND review.completed_at IS NULL
    ) AS pending ON true
    LEFT JOIN LATERAL (
      SELECT max(note.created_at) AS last_note_at
      FROM app.remedial_plan_notes AS note
      WHERE note.school_id = plan.school_id AND note.plan_id = plan.id
    ) AS notes ON true
    WHERE plan.school_id = ${schoolId}::uuid AND ${where}
    ORDER BY (plan.status IN ('open', 'in_progress')) DESC,
             (plan.status IN ('open', 'in_progress')
               AND pending.next_review_on IS NOT NULL
               AND pending.next_review_on < today.on_date) DESC,
             pending.next_review_on NULLS LAST, student.last_name, student.first_name,
             plan.created_at, plan.id
    ${limitSql}
  `;
}

function toSummary(row: PlanRow): RemedialPlanSummary {
  return {
    id: row.id,
    academic_year_id: row.academic_year_id,
    term_id: row.term_id,
    term_name: row.term_name,
    section_id: row.section_id,
    section_name: row.section_name,
    grade_level_id: row.grade_level_id,
    grade_level_name: row.grade_level_name,
    student_id: row.student_id,
    student_first_name: row.student_first_name,
    student_last_name: row.student_last_name,
    admission_number: row.admission_number,
    subject_id: row.subject_id,
    subject_name: row.subject_name ?? "",
    reason: row.reason,
    status: row.status,
    shared_with_family: row.shared_with_family,
    next_review_on: row.next_review_on,
    overdue: row.overdue,
    last_note_at: row.last_note_at?.toISOString() ?? null,
    created_by_name: row.created_by_name,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function familySharingEnabled(tx: TransactionSql, schoolId: string): Promise<boolean> {
  const [row] = await tx<{ enabled: boolean }[]>`
    SELECT remedial_plans_family_visible AS enabled
    FROM app.school_settings WHERE school_id = ${schoolId}::uuid
  `;
  return row?.enabled === true;
}

const isYearOpen = (status: GradingConfigStatus) => status !== "finalized" && status !== "archived";

/** Summaries plus each plan's reviews and timeline, in a fixed number of queries. */
async function toDetails(
  tx: TransactionSql,
  schoolId: string,
  rows: readonly PlanRow[],
): Promise<RemedialPlanDetail[]> {
  if (rows.length === 0) return [];
  const planIds = rows.map((row) => row.id);
  // RLS hides internal notes from the student and parents.
  const [reviews, notes, sharing] = await Promise.all([
    tx<{ plan_id: string; review_on: string; completed_at: Date | null; overdue: boolean }[]>`
      SELECT review.plan_id, review.review_on::text AS review_on, review.completed_at,
             (review.completed_at IS NULL AND review.review_on < app.school_today()) AS overdue
      FROM app.remedial_plan_reviews AS review
      WHERE review.school_id = ${schoolId}::uuid AND review.plan_id = ANY (${planIds}::uuid[])
      ORDER BY review.review_on
    `,
    tx<
      {
        id: string;
        plan_id: string;
        kind: "note" | "status_change";
        body: string | null;
        new_status: RemedialPlanStatus | null;
        internal: boolean;
        author_name: string | null;
        author_access: RemedialStaffAccess;
        created_at: Date;
      }[]
    >`
      SELECT note.id, note.plan_id, note.kind, note.body, note.new_status, note.internal,
             author.display_name AS author_name, note.author_access, note.created_at
      FROM app.remedial_plan_notes AS note
      JOIN app.users AS author
        ON author.id = note.author_user_id AND author.school_id = note.school_id
      WHERE note.school_id = ${schoolId}::uuid AND note.plan_id = ANY (${planIds}::uuid[])
      ORDER BY note.created_at, note.id
    `,
    familySharingEnabled(tx, schoolId),
  ]);
  return rows.map((row) => {
    const active = ACTIVE.includes(row.status);
    const access: RemedialPlanAccess = row.staff_access ?? "family";
    return {
      ...toSummary(row),
      reason_note: row.reason_note,
      targets: row.targets,
      actions: row.actions,
      start_percentage: num(row.start_percentage),
      pass_percentage: num(row.pass_percentage),
      reviews: reviews
        .filter((review) => review.plan_id === row.id)
        .map((review) => ({
          review_on: review.review_on,
          completed_at: review.completed_at?.toISOString() ?? null,
          overdue: active && review.overdue,
        })),
      notes: notes
        .filter((note) => note.plan_id === row.id)
        .map(({ plan_id: _plan, created_at, ...note }) => ({
          ...note,
          created_at: created_at.toISOString(),
        })),
      access,
      can_edit:
        (access === "leadership" || access === "teacher") && active && isYearOpen(row.year_status),
      can_add_note: row.staff_access !== null,
      family_sharing_enabled: sharing,
    };
  });
}

async function requirePlanRow(
  tx: TransactionSql,
  schoolId: string,
  planId: string,
): Promise<PlanRow> {
  const [row] = await loadPlanRows(tx, schoolId, tx`plan.id = ${planId}::uuid`);
  return row ?? fail(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Remedial plan not found");
}

export async function getRemedialPlan(
  tx: TransactionSql,
  schoolId: string,
  planId: string,
): Promise<RemedialPlanDetail> {
  const [detail] = await toDetails(tx, schoolId, [await requirePlanRow(tx, schoolId, planId)]);
  return detail!;
}

// ---------------------------------------------------------------------------
// Leadership's list (and anyone else who follows plans up)
// ---------------------------------------------------------------------------

export interface RemedialPlanListFilter {
  academic_year_id?: string;
  grade_level_id?: string;
  section_id?: string;
  subject_id?: string;
  status?: RemedialPlanStatus;
  overdue?: boolean;
}

export interface RemedialPlanListView {
  academic_year_id: string | null;
  counts: Record<RemedialPlanStatus | "overdue", number>;
  plans: RemedialPlanSummary[];
  truncated: boolean;
}

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

/**
 * The year's plans the caller follows as staff: every plan for leadership, a teacher's own
 * sections' subjects, a coordinator's subjects. A student's or parent's shared plans are not
 * listed here (they read them on the student's route).
 */
export async function listRemedialPlans(
  tx: TransactionSql,
  schoolId: string,
  filter: RemedialPlanListFilter,
): Promise<RemedialPlanListView> {
  const yearId = await resolveYearId(tx, schoolId, filter.academic_year_id);
  const counts = { open: 0, in_progress: 0, achieved: 0, closed: 0, overdue: 0 };
  if (!yearId) return { academic_year_id: null, counts, plans: [], truncated: false };

  const staffOnly = tx`
    plan.academic_year_id = ${yearId}::uuid
    AND app.remedial_plan_staff_access(plan.section_id, plan.subject_id) IS NOT NULL
  `;
  const countRows = await tx<{ status: RemedialPlanStatus; total: string; overdue: string }[]>`
      SELECT plan.status, count(*) AS total,
             count(*) FILTER (
               WHERE plan.status IN ('open', 'in_progress') AND EXISTS (
                 SELECT 1 FROM app.remedial_plan_reviews AS review
                 WHERE review.school_id = plan.school_id AND review.plan_id = plan.id
                   AND review.completed_at IS NULL AND review.review_on < app.school_today()
               )
             ) AS overdue
      FROM app.remedial_plans AS plan
      WHERE plan.school_id = ${schoolId}::uuid AND ${staffOnly}
      GROUP BY plan.status
    `;
  for (const row of countRows) {
    counts[row.status] = Number(row.total);
    counts.overdue += Number(row.overdue);
  }

  const conditions = [staffOnly];
  if (filter.grade_level_id) {
    conditions.push(tx`section.grade_level_id = ${filter.grade_level_id}::uuid`);
  }
  if (filter.section_id) conditions.push(tx`plan.section_id = ${filter.section_id}::uuid`);
  if (filter.subject_id) conditions.push(tx`plan.subject_id = ${filter.subject_id}::uuid`);
  if (filter.status) conditions.push(tx`plan.status = ${filter.status}`);
  if (filter.overdue !== undefined) {
    conditions.push(
      filter.overdue
        ? tx`(plan.status IN ('open', 'in_progress') AND pending.next_review_on < today.on_date)`
        : tx`NOT COALESCE(plan.status IN ('open', 'in_progress') AND pending.next_review_on < today.on_date, false)`,
    );
  }
  const where = conditions.reduce((all, condition) => tx`${all} AND ${condition}`);
  const rows = await loadPlanRows(tx, schoolId, where, REMEDIAL_LIMITS.listMax + 1);
  return {
    academic_year_id: yearId,
    counts,
    plans: rows.slice(0, REMEDIAL_LIMITS.listMax).map(toSummary),
    truncated: rows.length > REMEDIAL_LIMITS.listMax,
  };
}

// ---------------------------------------------------------------------------
// A section's subject: plans and suggestions
// ---------------------------------------------------------------------------

interface Standing {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_number: string;
  percentage: number | null;
  provisional: boolean;
}

interface SectionStanding {
  passPercentage: number | null;
  students: Standing[];
}

/**
 * Every student taking the subject in the section, with their percentage for the period from the
 * marks recorded so far (the rounded result when complete, the engine's preview otherwise). A
 * descriptive subject has no percentage. Loads the section's data once, never per student.
 */
async function sectionStanding(
  tx: TransactionSql,
  schoolId: string,
  section: SectionRow,
  subject: EffectiveSubject & { config_id: string },
  termId: string | null,
): Promise<SectionStanding> {
  const yearId = section.academic_year_id;
  const configs = (
    await loadYearConfigs(tx, schoolId, yearId, {
      gradeLevelIds: [section.grade_level_id],
      sectionIds: [section.id],
    })
  ).filter((config) => config.subject_id === subject.subject_id);
  const details = await loadConfigDetails(tx, schoolId, yearId, configs);
  const data = await loadSectionsGradingData(tx, schoolId, yearId, [section], {
    configs,
    details,
  });
  const engine = toEngineConfig(details.get(subject.config_id), { sectionId: section.id });
  const roster = rosterFrom(
    data.placements.get(section.id) ?? [],
    data.choices,
    subject.subject_id,
    subject.requirement,
  ).filter((student) => student.status === "enrolled");
  const descriptive = engine.method === "descriptive";
  const assessmentIds = new Set(engine.assessments.map((assessment) => assessment.id));
  return {
    passPercentage: descriptive ? null : engine.passPercentage,
    students: roster.map((student) => {
      const base = {
        student_id: student.student_id,
        first_name: student.first_name,
        last_name: student.last_name,
        admission_number: student.admission_number,
      };
      if (descriptive) return { ...base, percentage: null, provisional: false };
      const marks = (data.marksByStudent.get(student.student_id) ?? []).filter((mark) =>
        assessmentIds.has(mark.assessment_id),
      );
      const result = calculateSubjectResult(engine, toMarkInputs(marks, student.student_id), {
        termId,
      });
      const value = result.percentage ?? result.provisionalPercentage;
      return {
        ...base,
        percentage: value === null ? null : round2(value),
        provisional: result.status !== "complete",
      };
    }),
  };
}

async function requireTermInYear(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  termId: string,
): Promise<void> {
  const [term] = await tx<{ id: string }[]>`
    SELECT id FROM app.terms
    WHERE id = ${termId}::uuid AND school_id = ${schoolId}::uuid
      AND academic_year_id = ${yearId}::uuid
  `;
  if (!term) fail(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Term not found");
}

export interface SectionRemedialPlansView {
  section_id: string;
  section_name: string;
  grade_level_name: string;
  academic_year_id: string;
  subject_id: string;
  subject_name: string;
  term_id: string | null;
  terms: { term_id: string; term_name: string }[];
  access: SectionSubjectAccess;
  can_create: boolean;
  family_sharing_enabled: boolean;
  pass_percentage: number | null;
  students: {
    student_id: string;
    first_name: string;
    last_name: string;
    admission_number: string;
  }[];
  suggestions: {
    student_id: string;
    first_name: string;
    last_name: string;
    admission_number: string;
    percentage: number;
    provisional: boolean;
    active_plan_id: string | null;
  }[];
  plans: RemedialPlanSummary[];
}

/**
 * A section's subject for its teachers, its coordinator and leadership: every plan this year and
 * the students below the pass line for the period (term, or the year) on their current marks.
 */
export async function getSectionRemedialPlans(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
  termId: string | null,
): Promise<SectionRemedialPlansView> {
  const { access } = await assertCanReadSectionSubject(tx, sectionId, subjectId);
  const section = await requireSectionRow(tx, schoolId, sectionId);
  const subject = await requireEffectiveSubject(tx, schoolId, section, subjectId);
  if (termId !== null) await requireTermInYear(tx, schoolId, section.academic_year_id, termId);
  const year = await requireYear(tx, schoolId, section.academic_year_id);

  const [standing, rows, terms, sharing] = await Promise.all([
    sectionStanding(tx, schoolId, section, subject, termId),
    loadPlanRows(
      tx,
      schoolId,
      tx`plan.section_id = ${sectionId}::uuid AND plan.subject_id = ${subjectId}::uuid`,
    ),
    loadYearTerms(tx, schoolId, section.academic_year_id),
    familySharingEnabled(tx, schoolId),
  ]);
  const activeForPeriod = new Map(
    rows
      .filter((row) => ACTIVE.includes(row.status) && row.term_id === termId)
      .map((row) => [row.student_id, row.id]),
  );
  const pass = standing.passPercentage;
  const suggestions = standing.students
    .filter(
      (student): student is Standing & { percentage: number } =>
        pass !== null && student.percentage !== null && student.percentage < pass,
    )
    .sort((a, b) => a.percentage - b.percentage || a.last_name.localeCompare(b.last_name))
    .map((student) => ({
      ...student,
      active_plan_id: activeForPeriod.get(student.student_id) ?? null,
    }));

  return {
    section_id: section.id,
    section_name: section.name,
    grade_level_name: section.grade_level_name,
    academic_year_id: section.academic_year_id,
    subject_id: subjectId,
    subject_name: subject.subject_name,
    term_id: termId,
    terms: terms.map((term) => ({ term_id: term.id, term_name: term.name })),
    access,
    can_create: access !== "coordinator" && isYearOpen(year.grading_config_status),
    family_sharing_enabled: sharing,
    pass_percentage: pass,
    students: standing.students.map(({ student_id, first_name, last_name, admission_number }) => ({
      student_id,
      first_name,
      last_name,
      admission_number,
    })),
    suggestions,
    plans: rows.map(toSummary),
  };
}

// ---------------------------------------------------------------------------
// One student's plans (the student and parent apps, and staff)
// ---------------------------------------------------------------------------

/**
 * Leadership, a teacher of the student, a coordinator of one of the student's sections, or the
 * student and their linked parents. Each sees the plans RLS lets them read: the student and parents
 * only the shared ones, while the school allows it, without internal notes.
 */
export async function getStudentRemedialPlans(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<{ student_id: string; plans: RemedialPlanDetail[] }> {
  const [access] = await tx<{ allowed: boolean }[]>`
    SELECT (app.can_read_student(${studentId}::uuid)
            OR app.coordinates_student(${studentId}::uuid)) AS allowed
  `;
  if (!access?.allowed) fail(403, ERROR_CODES.ACCESS_DENIED, "Access denied");
  const [student] = await tx<{ id: string }[]>`
    SELECT id FROM app.students WHERE id = ${studentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!student) fail(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Student not found");
  const rows = await loadPlanRows(tx, schoolId, tx`plan.student_id = ${studentId}::uuid`);
  return { student_id: studentId, plans: await toDetails(tx, schoolId, rows) };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Distinct, ordered review dates. */
function reviewDates(dates: readonly string[]): string[] {
  return [...new Set(dates)].sort();
}

async function replaceReviews(
  tx: TransactionSql,
  schoolId: string,
  planId: string,
  dates: readonly string[],
): Promise<void> {
  // Dates kept keep whether they are done.
  await tx`
    DELETE FROM app.remedial_plan_reviews
    WHERE school_id = ${schoolId}::uuid AND plan_id = ${planId}::uuid
      AND NOT (review_on = ANY (${dates as string[]}::date[]))
  `;
  if (dates.length === 0) return;
  await tx`
    INSERT INTO app.remedial_plan_reviews (school_id, plan_id, review_on)
    SELECT ${schoolId}::uuid, ${planId}::uuid, review_on
    FROM unnest(${dates as string[]}::date[]) AS review_on
    ON CONFLICT (school_id, plan_id, review_on) DO NOTHING
  `;
}

/** Serialize writers to one student's plans in a subject and period (one active plan at a time). */
async function lockPeriod(
  tx: TransactionSql,
  yearId: string,
  studentId: string,
  subjectId: string,
  termId: string | null,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`remedial-plan:${yearId}:${studentId}:${subjectId}:${termId ?? "annual"}`}, 0))`;
}

async function assertNoActivePlan(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  studentId: string,
  subjectId: string,
  termId: string | null,
): Promise<void> {
  // A plain read: the writer teaches the subject in the section (or is leadership), so RLS shows
  // them any active plan of the student's in it.
  const [active] = await tx<{ id: string }[]>`
    SELECT id FROM app.remedial_plans
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
      AND term_id IS NOT DISTINCT FROM ${termId}::uuid AND student_id = ${studentId}::uuid
      AND subject_id = ${subjectId}::uuid AND status IN ('open', 'in_progress')
  `;
  if (active) {
    fail(
      409,
      ERROR_CODES.REMEDIAL_PLAN_DUPLICATE,
      "The student already has an active remedial plan in this subject for this period",
    );
  }
}

export interface CreateRemedialPlanInput {
  section_id: string;
  subject_id: string;
  student_id: string;
  term_id: string | null;
  reason: RemedialPlanReason;
  reason_note?: string | null;
  targets: string;
  actions: string;
  review_dates: string[];
  shared_with_family: boolean;
}

/** The section's teacher of the subject, or leadership, opens a plan for a student taking it. */
export async function createRemedialPlan(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  input: CreateRemedialPlanInput,
): Promise<RemedialPlanDetail> {
  await assertCanGradeSectionSubject(tx, input.section_id, input.subject_id);
  const section = await requireSectionRow(tx, schoolId, input.section_id);
  const subject = await requireEffectiveSubject(tx, schoolId, section, input.subject_id);
  const yearId = section.academic_year_id;
  if (input.term_id !== null) await requireTermInYear(tx, schoolId, yearId, input.term_id);
  assertConfigEditable(await requireYear(tx, schoolId, yearId));

  const standing = await sectionStanding(tx, schoolId, section, subject, input.term_id);
  const student = standing.students.find((row) => row.student_id === input.student_id);
  if (!student) {
    fail(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "The student does not take this subject in this section",
    );
  }
  const targets = required(input.targets, "targets");
  const actions = required(input.actions, "actions");
  const reasonNote = clean(input.reason_note);
  const dates = reviewDates(input.review_dates);

  await lockPeriod(tx, yearId, input.student_id, input.subject_id, input.term_id);
  await assertNoActivePlan(tx, schoolId, yearId, input.student_id, input.subject_id, input.term_id);

  const [plan] = await tx<{ id: string }[]>`
    INSERT INTO app.remedial_plans (
      school_id, academic_year_id, term_id, section_id, student_id, subject_id, reason,
      reason_note, start_percentage, pass_percentage, targets, actions, shared_with_family,
      created_by_user_id, updated_by_user_id
    ) VALUES (
      ${schoolId}::uuid, ${yearId}::uuid, ${input.term_id}::uuid, ${section.id}::uuid,
      ${input.student_id}::uuid, ${input.subject_id}::uuid, ${input.reason}, ${reasonNote},
      ${student.percentage}, ${standing.passPercentage}, ${targets}, ${actions},
      ${input.shared_with_family}, ${userId}::uuid, ${userId}::uuid
    )
    RETURNING id
  `;
  const planId = plan!.id;
  await replaceReviews(tx, schoolId, planId, dates);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "remedial_plans",
    targetId: planId,
    newValues: {
      academic_year_id: yearId,
      term_id: input.term_id,
      section_id: section.id,
      student_id: input.student_id,
      subject_id: input.subject_id,
      reason: input.reason,
      reason_note: reasonNote,
      start_percentage: student.percentage,
      pass_percentage: standing.passPercentage,
      targets,
      actions,
      review_dates: dates,
      shared_with_family: input.shared_with_family,
    },
  });
  return getRemedialPlan(tx, schoolId, planId);
}

export interface UpdateRemedialPlanInput {
  reason?: RemedialPlanReason;
  reason_note?: string | null;
  targets?: string;
  actions?: string;
  review_dates?: string[];
  status?: RemedialPlanStatus;
  status_note?: string | null;
  shared_with_family?: boolean;
}

/**
 * The plan's teacher or leadership changes it while it is active and its year open. A status
 * change is recorded on the timeline (with the optional note).
 */
export async function updateRemedialPlan(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  planId: string,
  input: UpdateRemedialPlanInput,
): Promise<RemedialPlanDetail> {
  const before = await getRemedialPlan(tx, schoolId, planId);
  if (before.access !== "leadership" && before.access !== "teacher") {
    fail(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "Only the plan's teacher or school leadership may change it",
    );
  }
  if (!ACTIVE.includes(before.status)) {
    fail(409, ERROR_CODES.REMEDIAL_PLAN_CLOSED, "This remedial plan is achieved or closed");
  }
  assertConfigEditable(await requireYear(tx, schoolId, before.academic_year_id));

  const status = input.status ?? before.status;
  if (status !== before.status && !NEXT_STATUSES[before.status].includes(status)) {
    fail(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `A plan that is ${before.status} cannot move to ${status}`,
    );
  }
  const next = {
    reason: input.reason ?? before.reason,
    reason_note: input.reason_note === undefined ? before.reason_note : clean(input.reason_note),
    targets: input.targets === undefined ? before.targets : required(input.targets, "targets"),
    actions: input.actions === undefined ? before.actions : required(input.actions, "actions"),
    status,
    shared_with_family: input.shared_with_family ?? before.shared_with_family,
  };
  const statusNote = clean(input.status_note);

  await tx`
    UPDATE app.remedial_plans
    SET reason = ${next.reason}, reason_note = ${next.reason_note}, targets = ${next.targets},
        actions = ${next.actions}, status = ${next.status},
        shared_with_family = ${next.shared_with_family}, updated_by_user_id = ${userId}::uuid,
        updated_at = GREATEST(CURRENT_TIMESTAMP, app.remedial_plans.created_at)
    WHERE id = ${planId}::uuid AND school_id = ${schoolId}::uuid
  `;
  const dates = input.review_dates === undefined ? undefined : reviewDates(input.review_dates);
  if (dates !== undefined) await replaceReviews(tx, schoolId, planId, dates);
  if (status !== before.status) {
    await tx`
      INSERT INTO app.remedial_plan_notes (
        school_id, plan_id, kind, body, new_status, internal, author_user_id, author_access
      ) VALUES (
        ${schoolId}::uuid, ${planId}::uuid, 'status_change', ${statusNote}, ${status}, false,
        ${userId}::uuid, ${before.access}
      )
    `;
  }

  const pick = (view: Pick<RemedialPlanDetail, keyof typeof next>) => ({
    reason: view.reason,
    reason_note: view.reason_note,
    targets: view.targets,
    actions: view.actions,
    status: view.status,
    shared_with_family: view.shared_with_family,
  });
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "remedial_plans",
    targetId: planId,
    oldValues: {
      ...pick(before),
      review_dates: before.reviews.map((review) => review.review_on),
    },
    newValues: {
      ...next,
      review_dates: dates ?? before.reviews.map((review) => review.review_on),
      ...(statusNote !== null && status !== before.status ? { status_note: statusNote } : {}),
    },
  });
  return getRemedialPlan(tx, schoolId, planId);
}

/**
 * A progress or follow-up note from anyone following the plan up (its teacher, the coordinator,
 * leadership). It completes every review due by today (school time).
 */
export async function addRemedialPlanNote(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  planId: string,
  input: { body: string; internal: boolean },
): Promise<RemedialPlanDetail> {
  const plan = await getRemedialPlan(tx, schoolId, planId);
  if (plan.access === "family") {
    fail(403, ERROR_CODES.AUTHZ_FORBIDDEN, "Only staff following the plan may add notes");
  }
  const body = required(input.body, "body");
  const [note] = await tx<{ id: string }[]>`
    INSERT INTO app.remedial_plan_notes (
      school_id, plan_id, kind, body, internal, author_user_id, author_access
    ) VALUES (
      ${schoolId}::uuid, ${planId}::uuid, 'note', ${body}, ${input.internal}, ${userId}::uuid,
      ${plan.access}
    )
    RETURNING id
  `;
  const completed = await tx<{ review_on: string }[]>`
    UPDATE app.remedial_plan_reviews
    SET completed_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND plan_id = ${planId}::uuid
      AND completed_at IS NULL AND review_on <= app.school_today()
    RETURNING review_on::text AS review_on
  `;
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "remedial_plan_notes",
    targetId: note!.id,
    newValues: {
      plan_id: planId,
      body,
      internal: input.internal,
      author_access: plan.access,
      reviews_completed: completed.map((row) => row.review_on),
    },
  });
  return getRemedialPlan(tx, schoolId, planId);
}

// ---------------------------------------------------------------------------
// The school's setting
// ---------------------------------------------------------------------------

export async function getRemedialSettings(
  tx: TransactionSql,
  schoolId: string,
): Promise<{ family_visible: boolean }> {
  return { family_visible: await familySharingEnabled(tx, schoolId) };
}

/** Leadership lets teachers share plans with the student and parents, or stops it. */
export async function updateRemedialSettings(
  tx: TransactionSql,
  schoolId: string,
  input: { family_visible: boolean },
): Promise<{ family_visible: boolean }> {
  const before = await familySharingEnabled(tx, schoolId);
  // The settings row is created lazily (as app.school_settings' own service does).
  await tx`
    INSERT INTO app.school_settings (school_id, remedial_plans_family_visible)
    VALUES (${schoolId}::uuid, ${input.family_visible})
    ON CONFLICT (school_id) DO UPDATE
    SET remedial_plans_family_visible = EXCLUDED.remedial_plans_family_visible,
        updated_at = GREATEST(CURRENT_TIMESTAMP, app.school_settings.created_at)
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "school_settings",
    targetId: schoolId,
    oldValues: { remedial_plans_family_visible: before },
    newValues: { remedial_plans_family_visible: input.family_visible },
  });
  return { family_visible: input.family_visible };
}
