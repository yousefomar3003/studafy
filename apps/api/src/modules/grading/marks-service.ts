import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";
import { calculateSubjectResult, summarizeWeights } from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emit } from "../../lib/events/emitter";
import { emitAuditLog } from "../../middleware/auditEmitter";

import {
  assertCanGradeSectionSubject,
  assertConfigEditable,
  assertMarksOpen,
  isSchoolLeadership,
  requireYear,
} from "./access";
import { descriptorViews } from "./descriptor-service";
import {
  effectiveSubjects,
  loadConfigDetail,
  loadMarks,
  loadRoster,
  loadYearConfigs,
  requireEffectiveSubject,
  requireProgram,
  requireSectionRow,
  sectionConfigs,
  toEngineConfig,
  toMarkInputs,
} from "./engine-config";

import type { GradingConfigStatus } from "./access";
import type { DescriptorView } from "./descriptor-service";
import type {
  EffectiveSubject,
  LoadedConfig,
  MarkRow,
  RosterStudent,
  SectionRow,
} from "./engine-config";
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

/**
 * One assessment's own release for one section (app.assessment_mark_releases, 000229). No stored
 * row is a `draft`.
 */
export type AssessmentReleaseStatus = "draft" | "submitted" | "approved" | "returned";

export interface AssessmentReleaseRow {
  id: string;
  section_id: string;
  subject_id: string;
  term_id: string | null;
  assessment_id: string;
  status: Exclude<AssessmentReleaseStatus, "draft">;
  submitted_by_user_id: string;
  submitted_at: Date;
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
  /** A graded mark in a descriptive subject: the chosen descriptor, instead of a score. */
  descriptor_id?: string | null;
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
    grading_method: "weighted" | "total_points" | "descriptive";
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
  descriptors: DescriptorView[];
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
    /** This assessment's own release (000229); `draft` with a null id when never sent. */
    release_id: string | null;
    release_status: AssessmentReleaseStatus;
    release_submitted_at: string | null;
    release_decided_at: string | null;
    release_return_reason: string | null;
    /** Visible to students and parents: its own release or its period's sheet is approved. */
    released: boolean;
    /** Enrolled students still without a usable mark for it; 0 = it can be sent for approval. */
    missing_count: number;
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
      descriptor_id: string | null;
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

const RELEASE_COLUMNS = `
  id, section_id, subject_id, term_id, assessment_id, status, submitted_by_user_id, submitted_at,
  decided_by_user_id, decided_at, return_reason, updated_at`;

async function loadReleases(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
): Promise<AssessmentReleaseRow[]> {
  return tx<AssessmentReleaseRow[]>`
    SELECT ${tx.unsafe(RELEASE_COLUMNS)} FROM app.assessment_mark_releases
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
      AND subject_id = ${subjectId}::uuid
  `;
}

/**
 * The enrolled students whose mark for one assessment is still missing, by the engine's own rule
 * (the one submitting a whole period uses): no mark at all, or an absence the school does not count
 * as zero. Releasing a single assessment is stricter than the period in two ways, so a release never
 * goes out with gaps: the assessment counts as mandatory even when it is optional, and a missing mark
 * is missing even where the school's policy would count it as zero. Excused / not applicable, a
 * counted absence and a graded retake all count as recorded.
 */
function studentsMissingAssessment(
  engine: SubjectGradingConfig,
  assessment: SubjectGradingConfig["assessments"][number],
  enrolled: readonly RosterStudent[],
  marks: readonly MarkRow[],
): RosterStudent[] {
  const single: SubjectGradingConfig = {
    ...engine,
    missingPolicy: "incomplete",
    assessments: [{ ...assessment, mandatory: true }],
  };
  const options = assessment.termId === null ? {} : { termId: assessment.termId };
  return enrolled.filter(
    (student) =>
      calculateSubjectResult(single, toMarkInputs(marks, student.student_id), options)
        .missingAssessments.length > 0,
  );
}

/**
 * An approved sheet releases its whole period: any of its assessments still waiting on their own
 * approval is approved with it (silently -- the family gets one notice for the sheet, not one per
 * assessment), and one marks.released event tells the student and their parents (MARKS_RELEASED).
 */
async function releaseSheet(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sheet: Pick<MarkSheetRow, "id" | "section_id" | "subject_id" | "term_id">,
): Promise<void> {
  await approvePendingReleases(tx, schoolId, userId, sheet);
  await emit(tx, DOMAIN_EVENTS.MARKS_RELEASED, {
    sectionId: sheet.section_id,
    subjectId: sheet.subject_id,
    termId: sheet.term_id,
    assessmentId: null,
  });
}

/**
 * Leadership approving a whole period's sheet approves the marks of every assessment in it, so any
 * of that period's assessments still waiting on their own approval is approved with it.
 */
async function approvePendingReleases(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sheet: Pick<MarkSheetRow, "id" | "section_id" | "subject_id" | "term_id">,
): Promise<void> {
  const approved = await tx<{ id: string; assessment_id: string }[]>`
    UPDATE app.assessment_mark_releases SET status = 'approved',
      decided_by_user_id = ${userId}::uuid, decided_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sheet.section_id}::uuid
      AND subject_id = ${sheet.subject_id}::uuid
      AND term_id IS NOT DISTINCT FROM ${sheet.term_id}::uuid
      AND status = 'submitted'
    RETURNING id, assessment_id
  `;
  for (const release of approved) {
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "assessment_mark_releases",
      targetId: release.id,
      oldValues: { status: "submitted" },
      newValues: { status: "approved", with_mark_sheet: sheet.id },
    });
  }
}

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
  if (candidates.length === 0) return [];

  // Sections, their configs and their sheets in three queries, not three per candidate.
  const sectionIds = [...new Set(candidates.map((candidate) => candidate.section_id))];
  const sectionRows = await tx<SectionRow[]>`
    SELECT section.id, section.name, section.academic_year_id, section.grade_level_id,
           grade.name AS grade_level_name, section.archived_at
    FROM app.sections AS section
    JOIN app.grade_levels AS grade
      ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    WHERE section.id = ANY (${sectionIds}::uuid[]) AND section.school_id = ${schoolId}::uuid
  `;
  const sectionsById = new Map(sectionRows.map((section) => [section.id, section]));
  const configs = await loadYearConfigs(tx, schoolId, years[0]!, {
    gradeLevelIds: [...new Set(sectionRows.map((section) => section.grade_level_id))],
    sectionIds,
  });
  const sheetRows = await tx<
    Pick<MarkSheetRow, "section_id" | "subject_id" | "term_id" | "status">[]
  >`
    SELECT sheet.section_id, sheet.subject_id, sheet.term_id, sheet.status
    FROM app.mark_sheets AS sheet
    LEFT JOIN app.terms AS term ON term.id = sheet.term_id AND term.school_id = sheet.school_id
    WHERE sheet.school_id = ${schoolId}::uuid AND sheet.section_id = ANY (${sectionIds}::uuid[])
    ORDER BY term.sequence_number NULLS LAST, sheet.id
  `;
  const subjectsBySection = new Map<string, EffectiveSubject[]>();

  const result: MyAssignment[] = [];
  for (const candidate of candidates) {
    const section = sectionsById.get(candidate.section_id);
    if (!section) {
      throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Section not found");
    }
    let subjects = subjectsBySection.get(section.id);
    if (!subjects) {
      subjects = effectiveSubjects(sectionConfigs(configs, section));
      subjectsBySection.set(section.id, subjects);
    }
    const subject = subjects.find((s) => s.subject_id === candidate.subject_id);
    if (!subject || subject.config_id === null) continue;
    // Each period's sheet, term order then annual (the order the sheet itself lists periods in).
    const sheets = sheetRows.filter(
      (sheet) => sheet.section_id === section.id && sheet.subject_id === subject.subject_id,
    );
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

function releaseView(release: AssessmentReleaseRow | undefined, sheet: MarkSheetRow | undefined) {
  return {
    release_id: release?.id ?? null,
    release_status: release?.status ?? ("draft" as const),
    release_submitted_at: release?.submitted_at.toISOString() ?? null,
    release_decided_at: release?.decided_at?.toISOString() ?? null,
    release_return_reason: release?.return_reason ?? null,
    released: release?.status === "approved" || sheet?.status === "approved",
  };
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
  const releases = await loadReleases(tx, schoolId, sectionId, subjectId);
  const enrolled = roster.filter((student) => student.status === "enrolled");
  const engineAssessments = new Map(engine.assessments.map((a) => [a.id, a]));

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
    descriptors:
      loaded.config.grading_method === "descriptive" ? descriptorViews(loaded.descriptors) : [],
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
      ...releaseView(
        releases.find((release) => release.assessment_id === assessment.id),
        sheetFor(sheets, assessment.term_id),
      ),
      missing_count: engineAssessments.has(assessment.id)
        ? studentsMissingAssessment(engine, engineAssessments.get(assessment.id)!, enrolled, marks)
            .length
        : enrolled.length,
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
          descriptor_id: mark.descriptor_id,
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

/**
 * A descriptive subject's mark: a graded one names a descriptor of the grade's scale and carries no
 * score; any other status carries neither.
 */
function assertDescriptorEntry(
  entry: MarkEntryInput,
  assessmentName: string,
  descriptorIds: ReadonlySet<string>,
): void {
  if (entry.score !== null) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `${assessmentName} is assessed with descriptors, not marks`,
    );
  }
  const descriptorId = entry.descriptor_id ?? null;
  if (entry.status === "graded") {
    if (descriptorId === null || !descriptorIds.has(descriptorId)) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `${assessmentName}: choose one of this grade's descriptors`,
      );
    }
  } else if (descriptorId !== null) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `A mark recorded as ${entry.status} carries no descriptor`,
    );
  }
}

const BATCH_LIMIT = 500;

/**
 * Record, change or clear marks for one section and subject.
 *
 * Every entry is checked against the effective configuration (the assessment must apply to this
 * section and be active), the roster (the student takes the subject and is not exempt), the
 * assessment's maximum, the period's mark sheet (submitted or approved sheets are locked) and the
 * assessment's own release (one sent for approval on its own, or released, is locked too). A mark
 * inside finalized results is refused by the database trigger. Old and new values go to the
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
  const releases = new Map(
    (await loadReleases(tx, schoolId, sectionId, subjectId)).map((r) => [r.assessment_id, r]),
  );
  const descriptive = loaded.config.grading_method === "descriptive";
  const descriptorIds = new Set(loaded.descriptors.map((descriptor) => descriptor.id));

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
    if (descriptive) {
      assertDescriptorEntry(entry, assessment.name, descriptorIds);
    } else if ((entry.descriptor_id ?? null) !== null) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `${assessment.name} is marked with numbers, not descriptors`,
      );
    } else if (entry.status === "graded") {
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
    // An assessment sent for approval on its own is locked the same way until it is returned; once
    // approved its marks are with the families, and only leadership withdrawing it reopens them.
    const release = releases.get(assessment.id);
    if (release && (release.status === "submitted" || release.status === "approved")) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.MARKS_LOCKED,
        `${assessment.name}: these marks are ${release.status === "approved" ? "released; an administrator must withdraw them first" : "awaiting approval; wait for the review or ask for them back"}`,
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
        ? {
            status: current.status,
            score: current.score,
            descriptor_id: current.descriptor_id,
            remarks: current.remarks,
          }
        : null;
      const descriptorId = entry.status === "graded" ? (entry.descriptor_id ?? null) : null;
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
              descriptor_id, remarks, entered_by_user_id
            ) VALUES (
              ${schoolId}::uuid, ${section.academic_year_id}::uuid, ${entry.assessment_id}::uuid,
              ${entry.student_id}::uuid, ${entry.attempt}, ${entry.status}, ${entry.score},
              ${descriptorId}::uuid, ${entry.remarks}, ${userId}::uuid
            )
            ON CONFLICT (school_id, assessment_id, student_id, attempt) DO UPDATE SET
              status = EXCLUDED.status, score = EXCLUDED.score,
              descriptor_id = EXCLUDED.descriptor_id, remarks = EXCLUDED.remarks,
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
            : {
                status: entry.status,
                score: entry.score,
                descriptor_id: descriptorId,
                remarks: entry.remarks,
              },
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

  // Likewise a teacher editing a returned assessment puts it back to draft (no release row).
  const touchedAssessments = new Set(entries.map((entry) => entry.assessment_id));
  for (const assessmentId of touchedAssessments) {
    const release = releases.get(assessmentId);
    if (release?.status === "returned") {
      await tx`
        DELETE FROM app.assessment_mark_releases
        WHERE id = ${release.id}::uuid AND school_id = ${schoolId}::uuid
      `;
      await emitAuditLog(tx, {
        action: "delete",
        targetTable: "assessment_mark_releases",
        targetId: release.id,
        oldValues: { status: release.status, return_reason: release.return_reason },
        newValues: { status: "draft" },
      });
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
  // A descriptive subject's skills carry no marks; max_marks is a fixed placeholder.
  const maxMarks = loaded.config.grading_method === "descriptive" ? 1 : input.max_marks;
  // On an override the whole config is the section's; on a grade default the row is section-scoped.
  const scopedSection = loaded.config.section_id === null ? sectionId : null;
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.subject_config_assessments (
      school_id, subject_config_id, academic_year_id, category_id, term_id, section_id, name,
      max_marks, weight, is_mandatory, assessment_date, due_date, status, created_by_user_id, sort_order
    ) VALUES (
      ${schoolId}::uuid, ${loaded.config.id}::uuid, ${loaded.config.academic_year_id}::uuid,
      ${input.category_id}::uuid, ${input.term_id}::uuid, ${scopedSection}::uuid, ${input.name},
      ${maxMarks}, ${input.weight}, ${input.is_mandatory}, ${input.assessment_date}::date,
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
  if (status === "approved") await releaseSheet(tx, schoolId, userId, sheet);
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
  // Reopening (or returning) the whole sheet leaves assessments approved on their own released: the
  // families have seen those marks, and they stay locked until leadership withdraws them one by one.
  if (status === "approved") await releaseSheet(tx, schoolId, userId, updated!);
  return updated!;
}

// ---------------------------------------------------------------------------
// Releasing one assessment at a time (000229)
// ---------------------------------------------------------------------------

/**
 * Send one assessment's marks for approval before the rest of its period is done. Every enrolled
 * student needs a usable mark for it ({@link studentsMissingAssessment}). It always waits for
 * leadership, who approve or return it from the approval queue -- also in a grade program whose
 * sheets need no approval step. Once approved, the marks are visible to the student and their
 * parents (app.is_released_student_mark), who are told (MARKS_RELEASED); the period's sheet, its
 * completeness rule and term results are untouched.
 */
export async function submitAssessmentRelease(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sectionId: string,
  subjectId: string,
  assessmentId: string,
): Promise<AssessmentReleaseRow> {
  const context = await sheetContext(tx, schoolId, sectionId, subjectId);
  const { section, engine, roster } = context;
  assertMarksOpen(await requireYear(tx, schoolId, section.academic_year_id));
  const assessment = engine.assessments.find((a) => a.id === assessmentId);
  if (!assessment) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "This assessment is not an active assessment of the subject for this section",
    );
  }
  const sheet = sheetFor(await loadSheets(tx, schoolId, sectionId, subjectId), assessment.termId);
  if (sheet && (sheet.status === "submitted" || sheet.status === "approved")) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      `The whole period's mark sheet is already ${sheet.status}; ${assessment.name} goes with it`,
    );
  }
  const [current] = await tx<AssessmentReleaseRow[]>`
    SELECT ${tx.unsafe(RELEASE_COLUMNS)} FROM app.assessment_mark_releases
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
      AND assessment_id = ${assessmentId}::uuid
    FOR UPDATE
  `;
  if (current && (current.status === "submitted" || current.status === "approved")) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      `${assessment.name} is already ${current.status === "approved" ? "released" : "awaiting approval"}`,
    );
  }

  const enrolled = roster.filter((student) => student.status === "enrolled");
  if (enrolled.length === 0) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "No student takes this subject in this section",
    );
  }
  const marks = await loadMarks(
    tx,
    schoolId,
    [assessmentId],
    enrolled.map((student) => student.student_id),
  );
  const missing = studentsMissingAssessment(engine, assessment, enrolled, marks).map(
    (student) => `${student.first_name} ${student.last_name}`,
  );
  if (missing.length > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RESULTS_INCOMPLETE,
      `${assessment.name}: marks are missing for ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` and ${missing.length - 10} more` : ""}`,
    );
  }

  // Always for leadership to approve, even where the grade program approves sheets on submit: a
  // teacher never publishes a single assessment directly (the owner's decision).
  const status = "submitted";
  const [release] = await tx<AssessmentReleaseRow[]>`
    INSERT INTO app.assessment_mark_releases (
      school_id, academic_year_id, section_id, subject_id, term_id, assessment_id, status,
      submitted_by_user_id, submitted_at, decided_by_user_id, decided_at
    ) VALUES (
      ${schoolId}::uuid, ${section.academic_year_id}::uuid, ${sectionId}::uuid, ${subjectId}::uuid,
      ${assessment.termId}::uuid, ${assessmentId}::uuid, ${status}, ${userId}::uuid,
      CURRENT_TIMESTAMP, NULL, NULL
    )
    ON CONFLICT (school_id, section_id, assessment_id) DO UPDATE SET
      status = EXCLUDED.status, submitted_by_user_id = EXCLUDED.submitted_by_user_id,
      submitted_at = EXCLUDED.submitted_at, decided_by_user_id = EXCLUDED.decided_by_user_id,
      decided_at = EXCLUDED.decided_at, return_reason = NULL, updated_at = CURRENT_TIMESTAMP
    RETURNING ${tx.unsafe(RELEASE_COLUMNS)}
  `;
  await emitAuditLog(tx, {
    action: current ? "update" : "insert",
    targetTable: "assessment_mark_releases",
    targetId: release!.id,
    oldValues: { status: current?.status ?? "draft" },
    newValues: {
      status,
      section_id: sectionId,
      subject_id: subjectId,
      assessment_id: assessmentId,
    },
  });
  return release!;
}

/**
 * Leadership's decision on one assessment's release: approve or return a submitted one, or reopen
 * (withdraw) an approved or submitted one, which hides its marks from the families again and hands
 * them back to the teacher. Returning and reopening need a reason. A release cannot be withdrawn
 * while the whole period's sheet is approved (the marks are released with the sheet; reopen that
 * first), nor once the marks are in finalized results.
 */
export async function decideAssessmentRelease(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  releaseId: string,
  action: "approve" | "return" | "reopen",
  reason: string | null,
): Promise<AssessmentReleaseRow> {
  if (!(await isSchoolLeadership(tx))) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "Only school leadership can review released marks",
    );
  }
  const [release] = await tx<(AssessmentReleaseRow & { academic_year_id: string })[]>`
    SELECT ${tx.unsafe(RELEASE_COLUMNS)}, academic_year_id FROM app.assessment_mark_releases
    WHERE id = ${releaseId}::uuid AND school_id = ${schoolId}::uuid
    FOR UPDATE
  `;
  if (!release) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Release not found");
  }
  assertMarksOpen(await requireYear(tx, schoolId, release.academic_year_id));

  const allowed =
    (action === "approve" && release.status === "submitted") ||
    (action === "return" && release.status === "submitted") ||
    (action === "reopen" && (release.status === "approved" || release.status === "submitted"));
  if (!allowed) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      `Cannot ${action} a ${release.status} release`,
    );
  }
  if ((action === "return" || action === "reopen") && !reason) {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, "Give the teacher a reason");
  }
  if (action === "reopen") {
    const sheet = sheetFor(
      await loadSheets(tx, schoolId, release.section_id, release.subject_id),
      release.term_id,
    );
    if (sheet?.status === "approved") {
      throw new CodedHttpException(
        409,
        ERROR_CODES.CONFLICT_STATE_MISMATCH,
        "The whole period's mark sheet is approved, so these marks are released with it; reopen the mark sheet first",
      );
    }
    const [finalized] = await tx<{ id: string }[]>`
      SELECT id FROM app.result_finalizations
      WHERE school_id = ${schoolId}::uuid AND section_id = ${release.section_id}::uuid
        AND status = 'finalized' AND (term_id IS NULL OR term_id IS NOT DISTINCT FROM ${release.term_id}::uuid)
    `;
    if (finalized) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.RESULTS_ALREADY_FINALIZED,
        "These marks are part of finalized results; use the correction workflow",
      );
    }
  }
  const status = action === "approve" ? "approved" : "returned";
  const [updated] = await tx<AssessmentReleaseRow[]>`
    UPDATE app.assessment_mark_releases SET status = ${status},
      decided_by_user_id = ${userId}::uuid, decided_at = CURRENT_TIMESTAMP,
      return_reason = ${action === "approve" ? null : reason}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${releaseId}::uuid AND school_id = ${schoolId}::uuid
    RETURNING ${tx.unsafe(RELEASE_COLUMNS)}
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "assessment_mark_releases",
    targetId: releaseId,
    oldValues: { status: release.status },
    newValues: { status, action, reason },
  });
  if (status === "approved") {
    await emit(tx, DOMAIN_EVENTS.MARKS_RELEASED, {
      sectionId: release.section_id,
      subjectId: release.subject_id,
      termId: release.term_id,
      assessmentId: release.assessment_id,
    });
  }
  return updated!;
}

export interface AssessmentReleaseListRow extends AssessmentReleaseRow {
  section_name: string;
  grade_level_name: string;
  subject_name: string;
  term_name: string | null;
  assessment_name: string;
  max_marks: string;
  submitted_by_name: string | null;
}

/** The year's single-assessment releases (leadership's queue), oldest submission first. */
export async function listAssessmentReleases(
  tx: TransactionSql,
  schoolId: string,
  filter: { yearId: string; status?: Exclude<AssessmentReleaseStatus, "draft"> },
): Promise<AssessmentReleaseListRow[]> {
  const statusFilter = filter.status ? tx`AND release_row.status = ${filter.status}` : tx``;
  return tx<AssessmentReleaseListRow[]>`
    SELECT release_row.id, release_row.section_id, release_row.subject_id, release_row.term_id,
           release_row.assessment_id, release_row.status, release_row.submitted_by_user_id,
           release_row.submitted_at, release_row.decided_by_user_id, release_row.decided_at,
           release_row.return_reason, release_row.updated_at,
           section.name AS section_name, grade.name AS grade_level_name,
           subject.name AS subject_name, term.name AS term_name,
           assessment.name AS assessment_name, assessment.max_marks,
           users.display_name AS submitted_by_name
    FROM app.assessment_mark_releases AS release_row
    JOIN app.sections AS section
      ON section.id = release_row.section_id AND section.school_id = release_row.school_id
    JOIN app.grade_levels AS grade
      ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    JOIN app.subjects AS subject
      ON subject.id = release_row.subject_id AND subject.school_id = release_row.school_id
    JOIN app.subject_config_assessments AS assessment
      ON assessment.id = release_row.assessment_id AND assessment.school_id = release_row.school_id
    LEFT JOIN app.terms AS term
      ON term.id = release_row.term_id AND term.school_id = release_row.school_id
    LEFT JOIN app.users AS users
      ON users.id = release_row.submitted_by_user_id AND users.school_id = release_row.school_id
    WHERE release_row.school_id = ${schoolId}::uuid
      AND release_row.academic_year_id = ${filter.yearId}::uuid
      ${statusFilter}
    ORDER BY release_row.submitted_at, grade.sort_order, section.name, subject.name,
             assessment.sort_order, assessment.name
  `;
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
  /** Descriptive subjects: the chosen descriptor of a graded mark. */
  descriptor_label: string | null;
}

export interface ReleasedAssessment {
  assessment_id: string;
  name: string;
  max_marks: number;
  assessment_date: string | null;
  /** When this assessment's marks reached the family: its own approval or its period sheet's. */
  released_at: string;
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
  /** The subject's Arabic name (000263); null when it has none. */
  subject_name_ar: string | null;
  /** When the whole period's mark sheet was approved; null while only single assessments are out. */
  approved_at: string | null;
  /**
   * False while only some assessments of the period are released one at a time: the rest of the
   * period's marks are still to come, so nothing here is a term result.
   */
  period_approved: boolean;
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
 * A student's released marks, newest year first, its terms in order and the annual period last. A
 * mark shows once leadership approves the sheet of its period (section, subject and term) or the
 * release of its own assessment for the student's section (000229), and disappears again if what
 * released it is reopened -- the same rule RLS enforces for a student or parent
 * (`app.is_released_student_mark`), applied here for every caller so leadership sees exactly what
 * the family sees. Remarks stay staff-only. No total or average is computed here: term results
 * reach families only through finalized results.
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
      subject_name_ar: string | null;
      approved_at: Date | null;
      period_approved: boolean;
      released_at: Date;
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
      descriptor_label: string | null;
    }[]
  >`
    SELECT year.id AS academic_year_id, year.name AS academic_year_name,
           assessment.term_id, term.name AS term_name,
           subject.id AS subject_id, subject.code AS subject_code, subject.name AS subject_name,
           subject.name_ar AS subject_name_ar, sheet.decided_at AS approved_at, sheet.id IS NOT NULL AS period_approved,
           LEAST(sheet.decided_at, release_row.decided_at) AS released_at,
           category.id AS category_id, category.name AS category_name, category.kind AS category_kind,
           assessment.id AS assessment_id, assessment.name AS assessment_name, assessment.max_marks,
           assessment.assessment_date::text AS assessment_date,
           mark.attempt, mark.status, mark.score, descriptor.label AS descriptor_label
    FROM app.student_marks AS mark
    LEFT JOIN app.grade_program_descriptors AS descriptor
      ON descriptor.id = mark.descriptor_id AND descriptor.school_id = mark.school_id
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
    LEFT JOIN app.mark_sheets AS sheet
      ON sheet.school_id = mark.school_id
     AND sheet.academic_year_id = assessment.academic_year_id
     AND sheet.section_id = placement.section_id
     AND sheet.subject_id = config.subject_id
     AND sheet.term_id IS NOT DISTINCT FROM assessment.term_id
     AND sheet.status = 'approved'
    LEFT JOIN app.assessment_mark_releases AS release_row
      ON release_row.school_id = mark.school_id
     AND release_row.section_id = placement.section_id
     AND release_row.assessment_id = assessment.id
     AND release_row.status = 'approved'
    JOIN app.academic_years AS year
      ON year.id = assessment.academic_year_id AND year.school_id = mark.school_id
    JOIN app.subjects AS subject ON subject.id = config.subject_id AND subject.school_id = mark.school_id
    LEFT JOIN app.terms AS term ON term.id = assessment.term_id AND term.school_id = mark.school_id
    WHERE mark.school_id = ${schoolId}::uuid
      AND mark.student_id = ${studentId}::uuid
      AND assessment.status = 'active'
      AND (assessment.section_id IS NULL OR assessment.section_id = placement.section_id)
      AND (sheet.id IS NOT NULL OR release_row.id IS NOT NULL)
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
        subject_name_ar: row.subject_name_ar,
        approved_at: row.approved_at?.toISOString() ?? null,
        period_approved: row.period_approved,
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
        released_at: row.released_at.toISOString(),
        attempts: [],
      };
      assessmentByKey.set(row.assessment_id, assessment);
      category.assessments.push(assessment);
    }
    assessment.attempts.push({
      attempt: row.attempt,
      status: row.status,
      score: row.score === null ? null : Number(row.score),
      descriptor_label: row.descriptor_label,
    });
  }
  return periods;
}
