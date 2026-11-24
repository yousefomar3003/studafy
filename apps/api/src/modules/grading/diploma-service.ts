import { ERROR_CODES } from "@studafy/constants";
import {
  DEFAULT_DIPLOMA_CONFIG,
  calculateDiplomaResult,
  isCoreGrade,
} from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { assertConfigEditable, requireYear } from "./access";
import { programDiplomaConfig } from "./diploma-config";
import {
  loadPlacements,
  loadScale,
  loadSubjectChoices,
  programResultFormat,
  requireConfig,
  requireProgram,
  requireSectionRow,
  resolveSectionSubjects,
} from "./engine-config";

import type { YearRow } from "./access";
import type { ProgramRow, SectionRow } from "./engine-config";
import type { StoredStudentResult } from "./results-service";
import type {
  CoreGrade,
  DiplomaCoreInput,
  DiplomaFailingCondition,
  DiplomaPendingReason,
  DiplomaResult,
  DiplomaStatus,
  DiplomaSubjectInput,
} from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * IB Diploma total (000263): the API side of the engine's `points_total` result.
 *
 *  - A grade program whose result format is `points_total` keeps its diploma rules (counted
 *    subjects, TOK x EE matrix, award conditions) in `diploma_config`, in the API's snake_case
 *    shape. Leadership edits them; the published IB values are the default.
 *  - Core grades (TOK, EE, CAS) are recorded per student and year, `final` and `predicted`. Final
 *    ones are read at finalization like marks and copied onto the result (`diploma_result`); a
 *    change after finalization reaches the result through the correction workflow, which reads the
 *    current core grades as it reads the current marks. Predicted ones, with phase 1's predicted
 *    subject grades, give the predicted total.
 *  - Writers: school leadership, or a teacher of the student's section (any subject: TOK and EE
 *    supervisors are usually the section's teachers). Readers: RLS (app.can_read_student_diploma_core).
 */

// ---------------------------------------------------------------------------
// The diploma outcome as the API, results and documents show it
// ---------------------------------------------------------------------------

export interface DiplomaResultView {
  status: DiplomaStatus;
  total: number | null;
  max: number;
  subject_points: number | null;
  core_points: number | null;
  counted_subject_ids: string[];
  tok_grade: CoreGrade | null;
  ee_grade: CoreGrade | null;
  cas_complete: boolean | null;
  failing_conditions: DiplomaFailingCondition[];
  pending_reasons: DiplomaPendingReason[];
}

/** The API view of an engine diploma result (also what a finalized row stores, read back). */
export function diplomaView(result: DiplomaResult | null | undefined): DiplomaResultView | null {
  if (!result) return null;
  return {
    status: result.status,
    total: result.total,
    max: result.max,
    subject_points: result.subjectPoints,
    core_points: result.corePoints,
    counted_subject_ids: result.countedSubjectIds,
    tok_grade: result.tok,
    ee_grade: result.ee,
    cas_complete: result.casComplete,
    failing_conditions: result.failingConditions,
    pending_reasons: result.pendingReasons,
  };
}

/** The diploma outcome an issued document keeps, as an optional field (absent without one). */
export function withDocumentDiploma(result: Pick<StoredStudentResult, "diploma">): {
  diploma?: DiplomaResultView;
} {
  return result.diploma ? { diploma: result.diploma } : {};
}

// ---------------------------------------------------------------------------
// Core grades
// ---------------------------------------------------------------------------

export type DiplomaCoreKind = "final" | "predicted";

interface CoreRow {
  student_id: string;
  kind: DiplomaCoreKind;
  tok_grade: CoreGrade | null;
  ee_grade: CoreGrade | null;
  cas_complete: boolean | null;
  updated_at: Date;
}

export interface DiplomaCoreValues {
  tok_grade: CoreGrade | null;
  ee_grade: CoreGrade | null;
  cas_complete: boolean | null;
  updated_at: string;
}

const valuesOf = (row: CoreRow | undefined): DiplomaCoreValues | null =>
  row
    ? {
        tok_grade: row.tok_grade,
        ee_grade: row.ee_grade,
        cas_complete: row.cas_complete,
        updated_at: row.updated_at.toISOString(),
      }
    : null;

const coreInput = (row: Pick<CoreRow, "tok_grade" | "ee_grade" | "cas_complete"> | undefined) =>
  ({
    tok: row?.tok_grade ?? null,
    ee: row?.ee_grade ?? null,
    casComplete: row?.cas_complete ?? null,
  }) satisfies DiplomaCoreInput;

async function loadCoreRows(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  studentIds: readonly string[],
): Promise<CoreRow[]> {
  if (studentIds.length === 0) return [];
  // RLS (app.can_read_student_diploma_core) returns only what the caller may read.
  return tx<CoreRow[]>`
    SELECT student_id, kind, tok_grade, ee_grade, cas_complete, updated_at
    FROM app.student_diploma_core_grades
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
      AND student_id = ANY (${studentIds as string[]}::uuid[])
  `;
}

/** The students' final core grades for a year, as finalization and corrections read them. */
export async function loadFinalDiplomaCore(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  studentIds: readonly string[],
): Promise<Map<string, DiplomaCoreInput>> {
  const rows = await loadCoreRows(tx, schoolId, yearId, studentIds);
  return new Map(
    rows.filter((row) => row.kind === "final").map((row) => [row.student_id, coreInput(row)]),
  );
}

async function assertCanEnterCore(tx: TransactionSql, sectionId: string): Promise<void> {
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT (app.current_user_is_school_admin() OR app.teaches_in_section(${sectionId}::uuid))
      AS allowed
  `;
  if (!row?.allowed) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "You do not teach in this section",
    );
  }
}

const isYearOpen = (year: YearRow) =>
  year.grading_config_status !== "finalized" && year.grading_config_status !== "archived";

export interface SectionDiplomaCoreView {
  section_id: string;
  section_name: string;
  grade_level_name: string;
  academic_year_id: string;
  enabled: boolean;
  predicted_enabled: boolean;
  editable: boolean;
  students: {
    student_id: string;
    first_name: string;
    last_name: string;
    admission_number: string;
    final: DiplomaCoreValues | null;
    predicted: DiplomaCoreValues | null;
  }[];
}

async function loadSection(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
): Promise<{ section: SectionRow; program: ProgramRow; year: YearRow }> {
  const section = await requireSectionRow(tx, schoolId, sectionId);
  const [program, year] = await Promise.all([
    requireProgram(tx, schoolId, section.academic_year_id, section.grade_level_id),
    requireYear(tx, schoolId, section.academic_year_id),
  ]);
  return { section, program, year };
}

/** Every student of the section with their final and predicted core grades for the year. */
export async function getSectionDiplomaCore(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
): Promise<SectionDiplomaCoreView> {
  await assertCanEnterCore(tx, sectionId);
  const { section, program, year } = await loadSection(tx, schoolId, sectionId);
  const roster = (await loadPlacements(tx, schoolId, [sectionId])).get(sectionId) ?? [];
  const rows = await loadCoreRows(
    tx,
    schoolId,
    section.academic_year_id,
    roster.map((student) => student.student_id),
  );
  const row = (studentId: string, kind: DiplomaCoreKind) =>
    rows.find((candidate) => candidate.student_id === studentId && candidate.kind === kind);
  const enabled = program.result_format === "points_total";
  return {
    section_id: section.id,
    section_name: section.name,
    grade_level_name: section.grade_level_name,
    academic_year_id: section.academic_year_id,
    enabled,
    predicted_enabled: enabled && program.predicted_grades_enabled,
    editable: enabled && isYearOpen(year),
    students: roster.map((student) => ({
      student_id: student.student_id,
      first_name: student.first_name,
      last_name: student.last_name,
      admission_number: student.admission_number,
      final: valuesOf(row(student.student_id, "final")),
      predicted: valuesOf(row(student.student_id, "predicted")),
    })),
  };
}

export interface DiplomaCoreItem {
  student_id: string;
  tok_grade: CoreGrade | null;
  ee_grade: CoreGrade | null;
  cas_complete: boolean | null;
}

export async function saveSectionDiplomaCore(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sectionId: string,
  kind: DiplomaCoreKind,
  items: readonly DiplomaCoreItem[],
): Promise<{ saved: number; cleared: number }> {
  await assertCanEnterCore(tx, sectionId);
  const { section, program, year } = await loadSection(tx, schoolId, sectionId);
  if (program.result_format !== "points_total") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.DIPLOMA_TOTAL_DISABLED,
      `${section.grade_level_name} does not use the IB Diploma total this year`,
    );
  }
  if (kind === "predicted" && !program.predicted_grades_enabled) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.PREDICTED_GRADES_DISABLED,
      `Predicted grades are not switched on for ${section.grade_level_name} this year`,
    );
  }
  assertConfigEditable(year);

  const ids = items.map((item) => item.student_id);
  if (new Set(ids).size !== ids.length) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "Each student may appear only once",
    );
  }
  const roster = new Set(
    ((await loadPlacements(tx, schoolId, [sectionId])).get(sectionId) ?? []).map(
      (student) => student.student_id,
    ),
  );
  const outside = ids.filter((id) => !roster.has(id));
  if (outside.length > 0) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `Not in this section: ${outside.slice(0, 5).join(", ")}`,
    );
  }

  const yearId = section.academic_year_id;
  const before = new Map(
    (await loadCoreRows(tx, schoolId, yearId, ids))
      .filter((row) => row.kind === kind)
      .map((row) => [row.student_id, valuesOf(row)]),
  );
  let saved = 0;
  let cleared = 0;
  const after: Record<string, Omit<DiplomaCoreItem, "student_id"> | null> = {};
  for (const item of items) {
    if (item.tok_grade === null && item.ee_grade === null && item.cas_complete === null) {
      const removed = await tx`
        DELETE FROM app.student_diploma_core_grades
        WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
          AND student_id = ${item.student_id}::uuid AND kind = ${kind}
      `;
      cleared += removed.count;
      after[item.student_id] = null;
      continue;
    }
    await tx`
      INSERT INTO app.student_diploma_core_grades (
        school_id, academic_year_id, student_id, kind, tok_grade, ee_grade, cas_complete,
        entered_by_user_id
      ) VALUES (
        ${schoolId}::uuid, ${yearId}::uuid, ${item.student_id}::uuid, ${kind},
        ${item.tok_grade}, ${item.ee_grade}, ${item.cas_complete}, ${userId}::uuid
      )
      ON CONFLICT (school_id, academic_year_id, student_id, kind) DO UPDATE SET
        tok_grade = EXCLUDED.tok_grade, ee_grade = EXCLUDED.ee_grade,
        cas_complete = EXCLUDED.cas_complete, entered_by_user_id = EXCLUDED.entered_by_user_id,
        updated_at = GREATEST(CURRENT_TIMESTAMP, app.student_diploma_core_grades.created_at)
    `;
    saved += 1;
    after[item.student_id] = {
      tok_grade: item.tok_grade,
      ee_grade: item.ee_grade,
      cas_complete: item.cas_complete,
    };
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "student_diploma_core_grades",
    targetId: sectionId,
    oldValues: {
      kind,
      grades: Object.fromEntries(ids.map((id) => [id, before.get(id) ?? null])),
    },
    newValues: { kind, grades: after },
  });
  return { saved, cleared };
}

// ---------------------------------------------------------------------------
// One student: core grades and the predicted total, by year
// ---------------------------------------------------------------------------

export interface StudentDiplomaYear {
  academic_year_id: string;
  academic_year_name: string;
  section_id: string;
  section_name: string;
  grade_level_name: string;
  can_edit: boolean;
  final: DiplomaCoreValues | null;
  predicted: DiplomaCoreValues | null;
  predicted_result: DiplomaResultView | null;
}

interface DiplomaPlacement {
  academic_year_id: string;
  academic_year_name: string;
  starts_on: Date;
  grading_config_status: YearRow["grading_config_status"];
  section_id: string;
  section_name: string;
  grade_level_id: string;
  grade_level_name: string;
}

/** Leadership, a teacher of the student, or the student and their linked parents. */
async function studentAccess(
  tx: TransactionSql,
  studentId: string,
): Promise<{ leadership: boolean; related: boolean }> {
  const [row] = await tx<{ leadership: boolean; related: boolean; teacher: boolean }[]>`
    SELECT app.current_user_is_school_admin() AS leadership,
           app.is_related_to_student(${studentId}::uuid) AS related,
           (app.current_user_teacher_id() IS NOT NULL
             AND app.can_read_student(${studentId}::uuid)) AS teacher
  `;
  if (!row?.leadership && !row?.related && !row?.teacher) {
    throw new CodedHttpException(403, ERROR_CODES.ACCESS_DENIED, "Access denied");
  }
  return { leadership: row.leadership, related: row.related && !row.leadership && !row.teacher };
}

/**
 * The years in which the student's grade uses the IB Diploma total, newest first, with their core
 * grades and the predicted total. The student and their parents get the predicted total and
 * predicted core grades only while the grade shows predicted grades to them, and never the final
 * core grades (those reach them on finalized results).
 */
export async function getStudentDiploma(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<{ student_id: string; years: StudentDiplomaYear[] }> {
  const access = await studentAccess(tx, studentId);
  const [student] = await tx<{ id: string }[]>`
    SELECT id FROM app.students WHERE id = ${studentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!student) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Student not found");
  }
  const placements = await tx<DiplomaPlacement[]>`
    SELECT placement.academic_year_id, year.name AS academic_year_name, year.starts_on,
           year.grading_config_status, section.id AS section_id, section.name AS section_name,
           grade.id AS grade_level_id, grade.name AS grade_level_name
    FROM app.student_sections AS placement
    JOIN app.academic_years AS year
      ON year.id = placement.academic_year_id AND year.school_id = placement.school_id
    JOIN app.sections AS section
      ON section.id = placement.section_id AND section.school_id = placement.school_id
    JOIN app.grade_levels AS grade
      ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    JOIN app.grade_programs AS program
      ON program.school_id = section.school_id
     AND program.academic_year_id = section.academic_year_id
     AND program.grade_level_id = section.grade_level_id
    WHERE placement.school_id = ${schoolId}::uuid AND placement.student_id = ${studentId}::uuid
      AND program.result_format = 'points_total'
    ORDER BY year.starts_on DESC
  `;

  const years: StudentDiplomaYear[] = [];
  for (const placement of placements) {
    const program = await requireProgram(
      tx,
      schoolId,
      placement.academic_year_id,
      placement.grade_level_id,
    );
    const rows = await loadCoreRows(tx, schoolId, placement.academic_year_id, [studentId]);
    const final = rows.find((row) => row.kind === "final");
    const predicted = rows.find((row) => row.kind === "predicted");
    const predictionsShown =
      program.predicted_grades_enabled &&
      (!access.related || program.predicted_grades_visibility === "students_and_parents");
    years.push({
      academic_year_id: placement.academic_year_id,
      academic_year_name: placement.academic_year_name,
      section_id: placement.section_id,
      section_name: placement.section_name,
      grade_level_name: placement.grade_level_name,
      can_edit:
        access.leadership &&
        placement.grading_config_status !== "finalized" &&
        placement.grading_config_status !== "archived",
      final: access.related ? null : valuesOf(final),
      predicted: predictionsShown ? valuesOf(predicted) : null,
      predicted_result: predictionsShown
        ? diplomaView(
            await predictedDiploma(tx, schoolId, studentId, placement, program, predicted),
          )
        : null,
    });
  }
  return { student_id: studentId, years };
}

/** A predicted grade label's points: its band's points on the scale, else the label as a number. */
function labelPoints(
  label: string,
  bands: readonly { label: string; gpaPoints: number | null }[],
): number | null {
  const band = bands.find((candidate) => candidate.label === label);
  if (band) return band.gpaPoints;
  const value = Number(label);
  return bands.length === 0 && label.trim() !== "" && Number.isFinite(value) ? value : null;
}

/**
 * The predicted total: each counted subject's prediction (the year's, else the latest term's)
 * turned into points on its scale, with the predicted core grades, through the same engine rules
 * as the finalized total. A counted subject without a prediction leaves the total pending.
 */
async function predictedDiploma(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  placement: DiplomaPlacement,
  program: ProgramRow,
  predictedCore: CoreRow | undefined,
): Promise<DiplomaResult> {
  const section: SectionRow = {
    id: placement.section_id,
    name: placement.section_name,
    academic_year_id: placement.academic_year_id,
    grade_level_id: placement.grade_level_id,
    grade_level_name: placement.grade_level_name,
    archived_at: null,
  };
  const yearId = placement.academic_year_id;
  const [choices, sectionSubjects, predictions] = await Promise.all([
    loadSubjectChoices(tx, schoolId, yearId, [studentId]),
    resolveSectionSubjects(tx, schoolId, section),
    // RLS (app.can_read_student_predicted_grade) already applies; latest period first.
    tx<{ subject_id: string; grade_label: string }[]>`
      SELECT prediction.subject_id, prediction.grade_label
      FROM app.student_predicted_grades AS prediction
      LEFT JOIN app.terms AS term
        ON term.id = prediction.term_id AND term.school_id = prediction.school_id
      WHERE prediction.school_id = ${schoolId}::uuid
        AND prediction.academic_year_id = ${yearId}::uuid
        AND prediction.student_id = ${studentId}::uuid
      ORDER BY prediction.term_id IS NULL DESC, term.sequence_number DESC
    `,
  ]);
  const scales = new Map<string, { label: string; gpaPoints: number | null }[]>();
  const subjects: DiplomaSubjectInput[] = [];
  for (const subject of sectionSubjects) {
    if (subject.config_id === null) continue;
    const choice = choices.get(`${studentId}|${subject.subject_id}`);
    if (choice === "exempt") continue;
    if (subject.requirement !== "mandatory" && choice !== "enrolled") continue;
    const config = await requireConfig(tx, schoolId, subject.config_id);
    if (!config.include_in_average || config.grading_method === "descriptive") continue;
    const scaleId = config.grade_scale_id ?? program.grade_scale_id;
    let bands = scaleId ? scales.get(scaleId) : [];
    if (bands === undefined && scaleId) {
      bands = (await loadScale(tx, schoolId, scaleId)).bands;
      scales.set(scaleId, bands);
    }
    const label = predictions.find(
      (prediction) => prediction.subject_id === subject.subject_id,
    )?.grade_label;
    subjects.push({
      subjectId: subject.subject_id,
      points: label === undefined ? null : labelPoints(label, bands ?? []),
      level: config.course_level,
    });
  }
  const format = programResultFormat(program);
  return calculateDiplomaResult(
    subjects,
    coreInput(predictedCore),
    programDiplomaConfig(program) ?? DEFAULT_DIPLOMA_CONFIG,
    format.max,
  );
}

/** A stored diploma result (jsonb), checked loosely: rows are written only by finalization. */
export function storedDiploma(value: unknown): DiplomaResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as DiplomaResult;
  return {
    ...result,
    tok: isCoreGrade(result.tok) ? result.tok : null,
    ee: isCoreGrade(result.ee) ? result.ee : null,
    failingConditions: result.failingConditions ?? [],
    pendingReasons: result.pendingReasons ?? [],
    countedSubjectIds: result.countedSubjectIds ?? [],
  };
}
