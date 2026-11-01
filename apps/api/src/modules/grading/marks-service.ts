import { ERROR_CODES } from "@studafy/constants";
import { calculateSubjectResult, summarizeWeights } from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import {
  assertCanGradeSectionSubject,
  assertConfigEditable,
  assertMarksOpen,
  isSchoolLeadership,
  requireYear,
} from "./access";
import {
  loadConfigDetail,
  loadMarks,
  loadRoster,
  requireEffectiveSubject,
  requireProgram,
  requireSectionRow,
  resolveSectionSubjects,
  toEngineConfig,
  toMarkInputs,
} from "./engine-config";

import type { GradingConfigStatus } from "./access";
import type { LoadedConfig, MarkRow, RosterStudent, SectionRow } from "./engine-config";
import type { MarkStatus, SubjectGradingConfig, SubjectResult } from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MarkSheetStatus = "draft" | "submitted" | "approved" | "returned";

export interface MarkSheetRow {
  id: string;
  section_id: string;
  subject_id: string;
  term_id: string | null;
  status: MarkSheetStatus;
  submitted_by_user_id: string | null;
  submitted_at: Date | null;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  return_reason: string | null;
  updated_at: Date;
}

export interface MarkEntryInput {
  assessment_id: string;
  student_id: string;
  attempt: 1 | 2;
  /** `pending` clears the mark (back to "not yet graded"). */
  status: MarkStatus | "pending";
  score: number | null;
  remarks: string | null;
  /** The mark's updated_at as last read; a mismatch is a concurrent edit. */
  expected_updated_at?: string | null;
}

export interface MarkSheetView {
  section: { id: string; name: string; grade_level_name: string; academic_year_id: string };
  subject: { id: string; code: string; name: string };
  config_id: string;
  source: string;
  year_status: GradingConfigStatus;
  can_edit_marks: boolean;
  can_add_assessments: boolean;
  config: {
    grading_method: "weighted" | "total_points";
    max_marks: number;
    pass_percentage: number;
    final_exam_pass_percentage: number | null;
    rounding_decimals: number;
    missing_mark_policy: string;
    absent_policy: string;
    retake_policy: string;
    instructions: string | null;
    weight_summary: ReturnType<typeof summarizeWeights>;
  };
  terms: { id: string; name: string; sequence_number: number; weight: number }[];
  categories: {
    id: string;
    name: string;
    kind: string;
    scope: string;
    weight: number | null;
    aggregation: string;
    drop_lowest: number;
  }[];
  assessments: {
    id: string;
    category_id: string;
    term_id: string | null;
    name: string;
    max_marks: number;
    weight: number;
    is_mandatory: boolean;
    assessment_date: string | null;
    due_date: string | null;
    status: string;
    section_specific: boolean;
  }[];
  mark_sheets: {
    id: string | null;
    term_id: string | null;
    status: MarkSheetStatus;
    submitted_at: string | null;
    decided_at: string | null;
    return_reason: string | null;
  }[];
  students: {
    student_id: string;
    first_name: string;
    last_name: string;
    admission_number: string;
    status: "enrolled" | "exempt";
    marks: {
      id: string;
      assessment_id: string;
      attempt: number;
      status: MarkStatus;
      score: number | null;
      remarks: string | null;
      updated_at: string;
    }[];
    /** Engine preview. `percentage` only when complete; `provisional_percentage` otherwise. */
    preview: {
      status: "complete" | "incomplete";
      percentage: number | null;
      provisional_percentage: number | null;
      grade_label: string | null;
      passed: boolean | null;
      missing_assessment_ids: string[];
      terms: { term_id: string | null; percentage: number | null; incomplete: boolean }[];
    } | null;
  }[];
}

// ---------------------------------------------------------------------------
// Mark sheets
// ---------------------------------------------------------------------------

const SHEET_COLUMNS = `
  id, section_id, subject_id, term_id, status, submitted_by_user_id, submitted_at,
  decided_by_user_id, decided_at, return_reason, updated_at`;

async function loadSheets(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
): Promise<MarkSheetRow[]> {
  return tx<MarkSheetRow[]>`
    SELECT ${tx.unsafe(SHEET_COLUMNS)} FROM app.mark_sheets
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid AND subject_id = ${subjectId}::uuid
  `;
}

/** The periods a config has marks in: each term with term assessments, plus annual if any. */
function periodsOf(engine: SubjectGradingConfig): (string | null)[] {
  const periods = new Set<string | null>();
  for (const assessment of engine.assessments) periods.add(assessment.termId);
  return [...periods].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    const sa = engine.terms.find((t) => t.termId === a)?.sequence ?? 0;
    const sb = engine.terms.find((t) => t.termId === b)?.sequence ?? 0;
    return sa - sb;
  });
}

const sheetFor = (sheets: MarkSheetRow[], termId: string | null) =>
  sheets.find((sheet) => sheet.term_id === termId);

// ---------------------------------------------------------------------------
// Teacher: my section subjects
// ---------------------------------------------------------------------------

export interface MyAssignment {
  academic_year_id: string;
  section_id: string;
  section_name: string;
  grade_level_name: string;
  subject_id: string;
  subject_name: string;
  config_id: string;
  sheets: { term_id: string | null; status: MarkSheetStatus }[];
}

/** Every section and subject the current teacher grades in the year (or the active year). */
export async function listMyAssignments(
  tx: TransactionSql,
  schoolId: string,
  yearId: string | undefined,
): Promise<MyAssignment[]> {
  const years = yearId
    ? [yearId]
    : (
        await tx<{ id: string }[]>`
          SELECT id FROM app.academic_years
          WHERE school_id = ${schoolId}::uuid AND grading_config_status IN ('active', 'finalized')
          ORDER BY starts_on DESC LIMIT 1
        `
      ).map((row) => row.id);
  if (years.length === 0) return [];

  const candidates = await tx<{ section_id: string; subject_id: string }[]>`
    SELECT DISTINCT section.id AS section_id, config.subject_id
    FROM app.sections AS section
    JOIN app.subject_configs AS config
      ON config.school_id = section.school_id AND config.academic_year_id = section.academic_year_id
     AND config.grade_level_id = section.grade_level_id
     AND (config.section_id IS NULL OR config.section_id = section.id)
    WHERE section.school_id = ${schoolId}::uuid AND section.academic_year_id = ${years[0]!}::uuid
      AND app.teaches_section_subject(section.id, config.subject_id)
  `;
  const result: MyAssignment[] = [];
  for (const candidate of candidates) {
    const section = await requireSectionRow(tx, schoolId, candidate.section_id);
    const subjects = await resolveSectionSubjects(tx, schoolId, section);
    const subject = subjects.find((s) => s.subject_id === candidate.subject_id);
    if (!subject || subject.config_id === null) continue;
    const sheets = await loadSheets(tx, schoolId, section.id, subject.subject_id);
    result.push({
      academic_year_id: section.academic_year_id,
      section_id: section.id,
      section_name: section.name,
      grade_level_name: section.grade_level_name,
      subject_id: subject.subject_id,
      subject_name: subject.subject_name,
      config_id: subject.config_id,
      sheets: sheets.map((sheet) => ({ term_id: sheet.term_id, status: sheet.status })),
    });
  }
  return result.sort(
    (a, b) =>
      a.grade_level_name.localeCompare(b.grade_level_name) ||
      a.section_name.localeCompare(b.section_name) ||
      a.subject_name.localeCompare(b.subject_name),
  );
}

// ---------------------------------------------------------------------------
// Mark sheet read
// ---------------------------------------------------------------------------

interface SheetContext {
  section: SectionRow;
  loaded: LoadedConfig;
  engine: SubjectGradingConfig;
  roster: RosterStudent[];
  source: string;
  leadership: boolean;
}

async function sheetContext(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
): Promise<SheetContext> {
  const section = await requireSectionRow(tx, schoolId, sectionId);
  const { leadership } = await assertCanGradeSectionSubject(tx, sectionId, subjectId);
  const subject = await requireEffectiveSubject(tx, schoolId, section, subjectId);
  const loaded = await loadConfigDetail(tx, schoolId, subject.config_id);
  const engine = toEngineConfig(loaded, { sectionId });
  const roster = await loadRoster(tx, schoolId, section, subjectId, subject.requirement);
  return { section, loaded, engine, roster, source: subject.source, leadership };
}

export function previewOf(
  result: SubjectResult,
): NonNullable<MarkSheetView["students"][number]["preview"]> {
  return {
    status: result.status,
    percentage: result.percentage,
    provisional_percentage:
      result.provisionalPercentage === null
        ? null
        : Math.round(result.provisionalPercentage * 100) / 100,
    grade_label: result.gradeLabel,
    passed: result.passed,
    missing_assessment_ids: result.missingAssessments.map((item) => item.assessmentId),
    terms: result.terms.map((term) => ({
      term_id: term.termId,
      percentage: term.percentage,
      incomplete: term.incomplete,
    })),
  };
}

export async function getMarkSheet(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
): Promise<MarkSheetView> {
  const context = await sheetContext(tx, schoolId, sectionId, subjectId);
  const { section, loaded, engine, roster } = context;
  const year = await requireYear(tx, schoolId, section.academic_year_id);
  const assessmentIds = engine.assessments.map((assessment) => assessment.id);
  const visibleAssessments = loaded.assessments.filter(
    (assessment) => assessment.section_id === null || assessment.section_id === sectionId,
  );
  const marks = await loadMarks(
    tx,
    schoolId,
    visibleAssessments.map((assessment) => assessment.id),
    roster.map((student) => student.student_id),
  );
  const sheets = await loadSheets(tx, schoolId, sectionId, subjectId);

  return {
    section: {
      id: section.id,
      name: section.name,
      grade_level_name: section.grade_level_name,
      academic_year_id: section.academic_year_id,
    },
    subject: {
      id: loaded.config.subject_id,
      code: loaded.config.subject_code,
      name: loaded.config.subject_name,
    },
    config_id: loaded.config.id,
    source: context.source,
    year_status: year.grading_config_status,
    can_edit_marks: year.grading_config_status === "active",
    can_add_assessments:
      year.grading_config_status === "active" &&
      (context.leadership || loaded.config.teachers_can_add_assessments),
    config: {
      grading_method: loaded.config.grading_method,
      max_marks: Number(loaded.config.max_marks),
      pass_percentage: Number(loaded.config.pass_percentage),
      final_exam_pass_percentage:
        loaded.config.final_exam_pass_percentage === null
          ? null
          : Number(loaded.config.final_exam_pass_percentage),
      rounding_decimals: loaded.config.rounding_decimals,
      missing_mark_policy: loaded.config.missing_mark_policy,
      absent_policy: loaded.config.absent_policy,
      retake_policy: loaded.config.retake_policy,
      instructions: loaded.config.instructions,
      weight_summary: summarizeWeights(engine),
    },
    terms: engine.terms.map((term) => ({
      id: term.termId,
      name: term.name,
      sequence_number: term.sequence,
      weight: term.weight,
    })),
    categories: loaded.categories.map((category) => ({
      id: category.id,
      name: category.name,
      kind: category.kind,
      scope: category.scope,
      weight: category.weight === null ? null : Number(category.weight),
      aggregation: category.aggregation,
      drop_lowest: category.drop_lowest,
    })),
    assessments: visibleAssessments.map((assessment) => ({
      id: assessment.id,
      category_id: assessment.category_id,
      term_id: assessment.term_id,
      name: assessment.name,
      max_marks: Number(assessment.max_marks),
      weight: Number(assessment.weight),
      is_mandatory: assessment.is_mandatory,
      assessment_date: assessment.assessment_date,
      due_date: assessment.due_date,
      status: assessment.status,
      section_specific: assessment.section_id !== null,
    })),
    mark_sheets: periodsOf(engine).map((termId) => {
      const sheet = sheetFor(sheets, termId);
      return {
        id: sheet?.id ?? null,
        term_id: termId,
        status: sheet?.status ?? "draft",
        submitted_at: sheet?.submitted_at?.toISOString() ?? null,
        decided_at: sheet?.decided_at?.toISOString() ?? null,
        return_reason: sheet?.return_reason ?? null,
      };
    }),
    students: roster.map((student) => {
      const own = marks.filter((mark) => mark.student_id === student.student_id);
      const counted = own.filter((mark) => assessmentIds.includes(mark.assessment_id));
      return {
        ...student,
        marks: own.map((mark) => ({
          id: mark.id,
          assessment_id: mark.assessment_id,
          attempt: mark.attempt,
          status: mark.status,
          score: mark.score === null ? null : Number(mark.score),
          remarks: mark.remarks,
          updated_at: mark.updated_at.toISOString(),
        })),
        preview:
          student.status === "exempt"
            ? null
            : previewOf(calculateSubjectResult(engine, toMarkInputs(counted, student.student_id))),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Mark entry
// ---------------------------------------------------------------------------

const BATCH_LIMIT = 500;

/**
 * Record, change or clear marks for one section and subject.
 *
 * Every entry is checked against the effective configuration (the assessment must apply to this
 * section and be active), the roster (the student takes the subject and is not exempt), the
 * assessment's maximum, and the period's mark sheet (submitted or approved sheets are locked). A
 * mark inside finalized results is refused by the database trigger. Old and new values go to the
 * audit log.
 */
export async function saveMarks(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sectionId: string,
  subjectId: string,
  entries: MarkEntryInput[],
): Promise<{ saved: number }> {
  if (entries.length > BATCH_LIMIT) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `At most ${BATCH_LIMIT} marks per request`,
    );
  }
  const context = await sheetContext(tx, schoolId, sectionId, subjectId);
  const { section, loaded, roster } = context;
  assertMarksOpen(await requireYear(tx, schoolId, section.academic_year_id));

  const assessments = new Map(
    loaded.assessments
      .filter((a) => a.status === "active" && (a.section_id === null || a.section_id === sectionId))
      .map((a) => [a.id, a]),
  );
  const students = new Map(roster.map((student) => [student.student_id, student]));
  const sheets = await loadSheets(tx, schoolId, sectionId, subjectId);

  for (const entry of entries) {
    const assessment = assessments.get(entry.assessment_id);
    if (!assessment) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `Assessment ${entry.assessment_id} is not part of this subject's assessments for the section`,
      );
    }
    const student = students.get(entry.student_id);
    if (!student) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `Student ${entry.student_id} does not take this subject in this section`,
      );
    }
    if (student.status === "exempt") {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `${student.first_name} ${student.last_name} is exempt from this subject`,
      );
    }
    if (entry.status === "graded") {
      if (entry.score === null || entry.score < 0 || entry.score > Number(assessment.max_marks)) {
        throw new CodedHttpException(
          400,
          ERROR_CODES.MARK_SCORE_OUT_OF_RANGE,
          `${assessment.name}: a mark must be between 0 and ${Number(assessment.max_marks)}`,
        );
      }
    } else if (entry.score !== null) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `A mark recorded as ${entry.status} carries no score`,
      );
    }
    if (entry.attempt === 2 && loaded.config.retake_policy === "none") {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        "This subject does not allow retakes",
      );
    }
    const sheet = sheetFor(sheets, assessment.term_id);
    if (sheet && (sheet.status === "submitted" || sheet.status === "approved")) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.MARKS_LOCKED,
        `${assessment.name}: the mark sheet is ${sheet.status}; ${sheet.status === "approved" ? "an administrator must reopen it" : "wait for the review or ask for it back"}`,
      );
    }
  }

  const existing = await loadMarks(
    tx,
    schoolId,
    [...new Set(entries.map((entry) => entry.assessment_id))],
    [...new Set(entries.map((entry) => entry.student_id))],
  );
  const key = (a: string, s: string, n: number) => `${a}|${s}|${n}`;
  const byKey = new Map<string, MarkRow>(
    existing.map((mark) => [key(mark.assessment_id, mark.student_id, mark.attempt), mark]),
  );

  const changes: {
    assessment_id: string;
    student_id: string;
    attempt: number;
    old: unknown;
    new: unknown;
  }[] = [];
  try {
    for (const entry of entries) {
      const current = byKey.get(key(entry.assessment_id, entry.student_id, entry.attempt));
      if (
        entry.expected_updated_at &&
        current &&
        new Date(entry.expected_updated_at).getTime() !== current.updated_at.getTime()
      ) {
        throw new CodedHttpException(
          409,
          ERROR_CODES.GRADE_CONCURRENT_EDIT,
          "A mark was changed by someone else. Reload and try again.",
        );
      }
      const old = current
        ? { status: current.status, score: current.score, remarks: current.remarks }
        : null;
      if (entry.status === "pending") {
        if (!current) continue;
        await tx.savepoint(
          (sp) =>
            sp`DELETE FROM app.student_marks WHERE id = ${current.id}::uuid AND school_id = ${schoolId}::uuid`,
        );
      } else {
        await tx.savepoint(
          (sp) => sp`
            INSERT INTO app.student_marks (
              school_id, academic_year_id, assessment_id, student_id, attempt, status, score,
              remarks, entered_by_user_id
            ) VALUES (
              ${schoolId}::uuid, ${section.academic_year_id}::uuid, ${entry.assessment_id}::uuid,
              ${entry.student_id}::uuid, ${entry.attempt}, ${entry.status}, ${entry.score},
              ${entry.remarks}, ${userId}::uuid
            )
            ON CONFLICT (school_id, assessment_id, student_id, attempt) DO UPDATE SET
              status = EXCLUDED.status, score = EXCLUDED.score, remarks = EXCLUDED.remarks,
              entered_by_user_id = EXCLUDED.entered_by_user_id, updated_at = CURRENT_TIMESTAMP
          `,
        );
      }
      changes.push({
        assessment_id: entry.assessment_id,
        student_id: entry.student_id,
        attempt: entry.attempt,
        old,
        new:
          entry.status === "pending"
            ? null
            : { status: entry.status, score: entry.score, remarks: entry.remarks },
      });
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "23514"
    ) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.MARKS_LOCKED,
        "These marks are part of finalized results; use the correction workflow",
      );
    }
    throw error;
  }

  // A teacher editing a returned sheet puts it back to draft.
  const touchedTerms = new Set(
    entries.map((entry) => assessments.get(entry.assessment_id)!.term_id),
  );
  for (const termId of touchedTerms) {
    const sheet = sheetFor(sheets, termId);
    if (sheet?.status === "returned") {
      await tx`
        UPDATE app.mark_sheets SET status = 'draft', return_reason = NULL, decided_at = NULL,
          decided_by_user_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${sheet.id}::uuid AND school_id = ${schoolId}::uuid
      `;
    }
  }

  if (changes.length > 0) {
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "student_marks",
      targetId: changes.length === 1 ? changes[0]!.student_id : sectionId,
      oldValues: { section_id: sectionId, subject_id: subjectId, marks: changes.map((c) => c.old) },
      newValues: { section_id: sectionId, subject_id: subjectId, changes },
    });
  }
  return { saved: changes.length };
}

// ---------------------------------------------------------------------------
// Teacher-added assessments
// ---------------------------------------------------------------------------

export interface AddAssessmentInput {
  category_id: string;
  term_id: string | null;
  name: string;
  max_marks: number;
  weight: number;
  is_mandatory: boolean;
  assessment_date: string | null;
  due_date: string | null;
}

/**
 * Add an assessment for one section. Leadership may always; a teacher only when the subject allows
 * it, and the addition waits as `proposed` until approved when the subject says so.
 */
export async function addSectionAssessment(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sectionId: string,
  subjectId: string,
  input: AddAssessmentInput,
): Promise<{ id: string; status: "active" | "proposed" }> {
  const context = await sheetContext(tx, schoolId, sectionId, subjectId);
  const { section, loaded, leadership } = context;
  const year = await requireYear(tx, schoolId, section.academic_year_id);
  assertConfigEditable(year);
  if (!leadership && !loaded.config.teachers_can_add_assessments) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "Teachers cannot add assessments to this subject",
    );
  }
  const category = loaded.categories.find((c) => c.id === input.category_id);
  if (!category) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "Unknown category for this subject",
    );
  }
  if ((category.scope === "term") !== (input.term_id !== null)) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.ACADEMIC_CONFIG_INVALID,
      category.scope === "term"
        ? `"${category.name}" is graded per term; choose a term`
        : `"${category.name}" is an annual category; it cannot belong to a term`,
    );
  }
  if (input.term_id !== null && !loaded.terms.some((term) => term.id === input.term_id)) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "The term is not in this academic year",
    );
  }
  const status =
    !leadership && loaded.config.teacher_assessments_require_approval ? "proposed" : "active";
  // On an override the whole config is the section's; on a grade default the row is section-scoped.
  const scopedSection = loaded.config.section_id === null ? sectionId : null;
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.subject_config_assessments (
      school_id, subject_config_id, academic_year_id, category_id, term_id, section_id, name,
      max_marks, weight, is_mandatory, assessment_date, due_date, status, created_by_user_id, sort_order
    ) VALUES (
      ${schoolId}::uuid, ${loaded.config.id}::uuid, ${loaded.config.academic_year_id}::uuid,
      ${input.category_id}::uuid, ${input.term_id}::uuid, ${scopedSection}::uuid, ${input.name},
      ${input.max_marks}, ${input.weight}, ${input.is_mandatory}, ${input.assessment_date}::date,
      ${input.due_date}::date, ${status}, ${userId}::uuid, 1000
    )
    RETURNING id
  `;
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "subject_config_assessments",
    targetId: row!.id,
    newValues: { section_id: sectionId, subject_id: subjectId, status, ...input },
  });
  return { id: row!.id, status };
}

export async function decideProposedAssessment(
  tx: TransactionSql,
  schoolId: string,
  assessmentId: string,
  action: "approve" | "reject",
): Promise<void> {
  const [assessment] = await tx<{ status: string; academic_year_id: string }[]>`
    SELECT status, academic_year_id FROM app.subject_config_assessments
    WHERE id = ${assessmentId}::uuid AND school_id = ${schoolId}::uuid
    FOR UPDATE
  `;
  if (!assessment)
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Assessment not found");
  if (assessment.status !== "proposed") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "Only a proposed assessment can be decided",
    );
  }
  assertConfigEditable(await requireYear(tx, schoolId, assessment.academic_year_id));
  const status = action === "approve" ? "active" : "rejected";
  await tx`
    UPDATE app.subject_config_assessments SET status = ${status}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${assessmentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "subject_config_assessments",
    targetId: assessmentId,
    oldValues: { status: "proposed" },
    newValues: { status },
  });
}

export async function listProposedAssessments(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<
  {
    id: string;
    name: string;
    subject_name: string;
    section_id: string | null;
    section_name: string | null;
    max_marks: number;
    created_by_name: string | null;
    created_at: string;
  }[]
> {
  const rows = await tx<
    {
      id: string;
      name: string;
      subject_name: string;
      section_id: string | null;
      section_name: string | null;
      max_marks: string;
      created_by_name: string | null;
      created_at: Date;
    }[]
  >`
    SELECT assessment.id, assessment.name, subject.name AS subject_name,
           COALESCE(assessment.section_id, config.section_id) AS section_id,
           section.name AS section_name, assessment.max_marks,
           users.display_name AS created_by_name, assessment.created_at
    FROM app.subject_config_assessments AS assessment
    JOIN app.subject_configs AS config
      ON config.id = assessment.subject_config_id AND config.school_id = assessment.school_id
    JOIN app.subjects AS subject ON subject.id = config.subject_id AND subject.school_id = config.school_id
    LEFT JOIN app.sections AS section
      ON section.id = COALESCE(assessment.section_id, config.section_id) AND section.school_id = assessment.school_id
    LEFT JOIN app.users AS users
      ON users.id = assessment.created_by_user_id AND users.school_id = assessment.school_id
    WHERE assessment.school_id = ${schoolId}::uuid AND assessment.academic_year_id = ${yearId}::uuid
      AND assessment.status = 'proposed'
    ORDER BY assessment.created_at
  `;
  return rows.map((row) => ({
    ...row,
    max_marks: Number(row.max_marks),
    created_at: row.created_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Submission and approval
// ---------------------------------------------------------------------------

/**
 * Submit one period's marks (`termId`, or null for annual-only assessments). Every enrolled student
 * must have a usable mark for every mandatory assessment of the period. Without an approval step
 * (the grade program's choice) the sheet is approved straight away.
 */
export async function submitMarkSheet(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sectionId: string,
  subjectId: string,
  termId: string | null,
): Promise<MarkSheetRow> {
  const context = await sheetContext(tx, schoolId, sectionId, subjectId);
  const { section, engine, roster } = context;
  assertMarksOpen(await requireYear(tx, schoolId, section.academic_year_id));
  const periodAssessments = engine.assessments.filter((assessment) => assessment.termId === termId);
  if (periodAssessments.length === 0) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "There are no assessments in this period",
    );
  }
  const enrolled = roster.filter((student) => student.status === "enrolled");
  const marks = await loadMarks(
    tx,
    schoolId,
    periodAssessments.map((assessment) => assessment.id),
    enrolled.map((student) => student.student_id),
  );
  const missing: string[] = [];
  for (const student of enrolled) {
    const periodConfig = { ...engine, assessments: periodAssessments };
    const result = calculateSubjectResult(
      periodConfig,
      toMarkInputs(marks, student.student_id),
      termId === null ? {} : { termId },
    );
    if (result.missingAssessments.length > 0) {
      missing.push(
        `${student.first_name} ${student.last_name} (${result.missingAssessments.map((m) => m.name).join(", ")})`,
      );
    }
  }
  if (missing.length > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RESULTS_INCOMPLETE,
      `Marks are missing for: ${missing.slice(0, 10).join("; ")}${missing.length > 10 ? ` and ${missing.length - 10} more` : ""}`,
    );
  }

  const program = await requireProgram(
    tx,
    schoolId,
    section.academic_year_id,
    section.grade_level_id,
  );
  const sheets = await loadSheets(tx, schoolId, sectionId, subjectId);
  const current = sheetFor(sheets, termId);
  if (current && (current.status === "submitted" || current.status === "approved")) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      `This mark sheet is already ${current.status}`,
    );
  }
  const approveNow = !program.mark_approval_required;
  const status: MarkSheetStatus = approveNow ? "approved" : "submitted";
  let sheet: MarkSheetRow;
  if (current) {
    [sheet] = (await tx<MarkSheetRow[]>`
      UPDATE app.mark_sheets SET status = ${status}, submitted_by_user_id = ${userId}::uuid,
        submitted_at = CURRENT_TIMESTAMP, return_reason = NULL,
        decided_by_user_id = ${approveNow ? userId : null}::uuid,
        decided_at = ${approveNow ? new Date() : null},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${current.id}::uuid AND school_id = ${schoolId}::uuid
      RETURNING ${tx.unsafe(SHEET_COLUMNS)}
    `) as unknown as [MarkSheetRow];
  } else {
    [sheet] = (await tx<MarkSheetRow[]>`
      INSERT INTO app.mark_sheets (
        school_id, academic_year_id, section_id, subject_id, term_id, status,
        submitted_by_user_id, submitted_at, decided_by_user_id, decided_at
      ) VALUES (
        ${schoolId}::uuid, ${section.academic_year_id}::uuid, ${sectionId}::uuid, ${subjectId}::uuid,
        ${termId}::uuid, ${status}, ${userId}::uuid, CURRENT_TIMESTAMP,
        ${approveNow ? userId : null}::uuid, ${approveNow ? new Date() : null}
      )
      RETURNING ${tx.unsafe(SHEET_COLUMNS)}
    `) as unknown as [MarkSheetRow];
  }
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "mark_sheets",
    targetId: sheet.id,
    oldValues: { status: current?.status ?? "draft" },
    newValues: { status, term_id: termId },
  });
  return sheet;
}

export async function decideMarkSheet(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sheetId: string,
  action: "approve" | "return" | "reopen",
  reason: string | null,
): Promise<MarkSheetRow> {
  if (!(await isSchoolLeadership(tx))) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "Only school leadership can review mark sheets",
    );
  }
  const [sheet] = await tx<(MarkSheetRow & { academic_year_id: string })[]>`
    SELECT ${tx.unsafe(SHEET_COLUMNS)}, academic_year_id FROM app.mark_sheets
    WHERE id = ${sheetId}::uuid AND school_id = ${schoolId}::uuid
    FOR UPDATE
  `;
  if (!sheet)
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Mark sheet not found");
  assertMarksOpen(await requireYear(tx, schoolId, sheet.academic_year_id));

  const allowed =
    (action === "approve" && sheet.status === "submitted") ||
    (action === "return" && sheet.status === "submitted") ||
    (action === "reopen" && (sheet.status === "approved" || sheet.status === "submitted"));
  if (!allowed) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      `Cannot ${action} a ${sheet.status} mark sheet`,
    );
  }
  if ((action === "return" || action === "reopen") && !reason) {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, "Give the teacher a reason");
  }
  if (action === "reopen") {
    const [finalized] = await tx<{ id: string }[]>`
      SELECT id FROM app.result_finalizations
      WHERE school_id = ${schoolId}::uuid AND section_id = ${sheet.section_id}::uuid
        AND status = 'finalized' AND (term_id IS NULL OR term_id IS NOT DISTINCT FROM ${sheet.term_id}::uuid)
    `;
    if (finalized) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.RESULTS_ALREADY_FINALIZED,
        "These marks are part of finalized results; use the correction workflow",
      );
    }
  }
  const status: MarkSheetStatus =
    action === "approve" ? "approved" : action === "return" ? "returned" : "returned";
  const [updated] = await tx<MarkSheetRow[]>`
    UPDATE app.mark_sheets SET status = ${status}, decided_by_user_id = ${userId}::uuid,
      decided_at = CURRENT_TIMESTAMP, return_reason = ${action === "approve" ? null : reason},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${sheetId}::uuid AND school_id = ${schoolId}::uuid
    RETURNING ${tx.unsafe(SHEET_COLUMNS)}
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "mark_sheets",
    targetId: sheetId,
    oldValues: { status: sheet.status },
    newValues: { status, action, reason },
  });
  return updated!;
}

export async function listMarkSheets(
  tx: TransactionSql,
  schoolId: string,
  filter: { yearId: string; status?: MarkSheetStatus },
): Promise<
  (MarkSheetRow & {
    section_name: string;
    grade_level_name: string;
    subject_name: string;
    term_name: string | null;
    submitted_by_name: string | null;
  })[]
> {
  const statusFilter = filter.status ? tx`AND sheet.status = ${filter.status}` : tx``;
  return tx`
    SELECT sheet.id, sheet.section_id, sheet.subject_id, sheet.term_id, sheet.status,
           sheet.submitted_by_user_id, sheet.submitted_at, sheet.decided_by_user_id,
           sheet.decided_at, sheet.return_reason, sheet.updated_at,
           section.name AS section_name, grade.name AS grade_level_name,
           subject.name AS subject_name, term.name AS term_name,
           users.display_name AS submitted_by_name
    FROM app.mark_sheets AS sheet
    JOIN app.sections AS section ON section.id = sheet.section_id AND section.school_id = sheet.school_id
    JOIN app.grade_levels AS grade ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    JOIN app.subjects AS subject ON subject.id = sheet.subject_id AND subject.school_id = sheet.school_id
    LEFT JOIN app.terms AS term ON term.id = sheet.term_id AND term.school_id = sheet.school_id
    LEFT JOIN app.users AS users ON users.id = sheet.submitted_by_user_id AND users.school_id = sheet.school_id
    WHERE sheet.school_id = ${schoolId}::uuid AND sheet.academic_year_id = ${filter.yearId}::uuid
      ${statusFilter}
    ORDER BY sheet.submitted_at NULLS LAST, grade.sort_order, section.name, subject.name
  `;
}

// ---------------------------------------------------------------------------
// Released marks (student and parent view)
// ---------------------------------------------------------------------------

export interface ReleasedMarkAttempt {
  attempt: number;
  status: MarkStatus;
  score: number | null;
}

export interface ReleasedAssessment {
  assessment_id: string;
  name: string;
  max_marks: number;
  assessment_date: string | null;
  attempts: ReleasedMarkAttempt[];
}

export interface ReleasedCategory {
  category_id: string;
  name: string;
  kind: string;
  assessments: ReleasedAssessment[];
}

export interface ReleasedSubject {
  subject_id: string;
  subject_code: string;
  subject_name: string;
  approved_at: string | null;
  categories: ReleasedCategory[];
}

/** One period of a year: a term, or the annual period (`term_id` null) for year-long assessments. */
export interface ReleasedPeriod {
  academic_year_id: string;
  academic_year_name: string;
  term_id: string | null;
  term_name: string | null;
  subjects: ReleasedSubject[];
}

/**
 * A student's marks from approved mark sheets, newest year first, its terms in order and the
 * annual period last. A mark shows once leadership approves the sheet of its period (section,
 * subject and term), and disappears again if the sheet is reopened -- the same rule RLS enforces
 * for a student or parent (000173 `app.is_released_student_mark`), applied here for every caller so
 * leadership sees exactly what the family sees. Remarks stay staff-only.
 */
export async function listReleasedStudentMarks(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<ReleasedPeriod[]> {
  const rows = await tx<
    {
      academic_year_id: string;
      academic_year_name: string;
      term_id: string | null;
      term_name: string | null;
      subject_id: string;
      subject_code: string;
      subject_name: string;
      approved_at: Date | null;
      category_id: string;
      category_name: string;
      category_kind: string;
      assessment_id: string;
      assessment_name: string;
      max_marks: string;
      assessment_date: string | null;
      attempt: number;
      status: MarkStatus;
      score: string | null;
    }[]
  >`
    SELECT year.id AS academic_year_id, year.name AS academic_year_name,
           sheet.term_id, term.name AS term_name,
           subject.id AS subject_id, subject.code AS subject_code, subject.name AS subject_name,
           sheet.decided_at AS approved_at,
           category.id AS category_id, category.name AS category_name, category.kind AS category_kind,
           assessment.id AS assessment_id, assessment.name AS assessment_name, assessment.max_marks,
           assessment.assessment_date::text AS assessment_date,
           mark.attempt, mark.status, mark.score
    FROM app.student_marks AS mark
    JOIN app.subject_config_assessments AS assessment
      ON assessment.id = mark.assessment_id AND assessment.school_id = mark.school_id
    JOIN app.subject_config_categories AS category
      ON category.id = assessment.category_id AND category.school_id = assessment.school_id
    JOIN app.subject_configs AS config
      ON config.id = assessment.subject_config_id AND config.school_id = assessment.school_id
    JOIN app.student_sections AS placement
      ON placement.student_id = mark.student_id
     AND placement.academic_year_id = assessment.academic_year_id
     AND placement.school_id = mark.school_id
    JOIN app.mark_sheets AS sheet
      ON sheet.school_id = mark.school_id
     AND sheet.academic_year_id = assessment.academic_year_id
     AND sheet.section_id = placement.section_id
     AND sheet.subject_id = config.subject_id
     AND sheet.term_id IS NOT DISTINCT FROM assessment.term_id
    JOIN app.academic_years AS year
      ON year.id = assessment.academic_year_id AND year.school_id = mark.school_id
    JOIN app.subjects AS subject ON subject.id = config.subject_id AND subject.school_id = mark.school_id
    LEFT JOIN app.terms AS term ON term.id = sheet.term_id AND term.school_id = mark.school_id
    WHERE mark.school_id = ${schoolId}::uuid
      AND mark.student_id = ${studentId}::uuid
      AND assessment.status = 'active'
      AND (assessment.section_id IS NULL OR assessment.section_id = placement.section_id)
      AND sheet.status = 'approved'
    ORDER BY year.starts_on DESC, term.sequence_number NULLS LAST, subject.name,
             category.sort_order, category.name, assessment.sort_order, assessment.name, mark.attempt
  `;

  const periods: ReleasedPeriod[] = [];
  const periodByKey = new Map<string, ReleasedPeriod>();
  const subjectByKey = new Map<string, ReleasedSubject>();
  const categoryByKey = new Map<string, ReleasedCategory>();
  const assessmentByKey = new Map<string, ReleasedAssessment>();
  for (const row of rows) {
    const periodKey = `${row.academic_year_id}:${row.term_id ?? "annual"}`;
    let period = periodByKey.get(periodKey);
    if (!period) {
      period = {
        academic_year_id: row.academic_year_id,
        academic_year_name: row.academic_year_name,
        term_id: row.term_id,
        term_name: row.term_name,
        subjects: [],
      };
      periodByKey.set(periodKey, period);
      periods.push(period);
    }
    const subjectKey = `${periodKey}:${row.subject_id}`;
    let subject = subjectByKey.get(subjectKey);
    if (!subject) {
      subject = {
        subject_id: row.subject_id,
        subject_code: row.subject_code,
        subject_name: row.subject_name,
        approved_at: row.approved_at?.toISOString() ?? null,
        categories: [],
      };
      subjectByKey.set(subjectKey, subject);
      period.subjects.push(subject);
    }
    const categoryKey = `${subjectKey}:${row.category_id}`;
    let category = categoryByKey.get(categoryKey);
    if (!category) {
      category = {
        category_id: row.category_id,
        name: row.category_name,
        kind: row.category_kind,
        assessments: [],
      };
      categoryByKey.set(categoryKey, category);
      subject.categories.push(category);
    }
    let assessment = assessmentByKey.get(row.assessment_id);
    if (!assessment) {
      assessment = {
        assessment_id: row.assessment_id,
        name: row.assessment_name,
        max_marks: Number(row.max_marks),
        assessment_date: row.assessment_date,
        attempts: [],
      };
      assessmentByKey.set(row.assessment_id, assessment);
      category.assessments.push(assessment);
    }
    assessment.attempts.push({
      attempt: row.attempt,
      status: row.status,
      score: row.score === null ? null : Number(row.score),
    });
  }
  return periods;
}
