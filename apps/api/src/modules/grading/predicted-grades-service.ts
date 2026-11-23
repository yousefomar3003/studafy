import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { assertCanGradeSectionSubject, assertConfigEditable, requireYear } from "./access";
import {
  loadRoster,
  loadScale,
  loadSubjectChoices,
  loadYearTerms,
  requireConfig,
  requireEffectiveSubject,
  requireProgram,
  requireSectionRow,
  resolveSectionSubjects,
} from "./engine-config";

import type { YearRow } from "./access";
import type { PredictedGradesVisibility, ProgramRow, SectionRow } from "./engine-config";
import type { TransactionSql } from "postgres";

/**
 * Predicted grades (000254): a teacher's forecast of the grade a student will reach in a subject,
 * for one term or for the year (IGCSE, A-Level and IB schools send them to universities).
 *
 * A grade's program for the year opts in (`predicted_grades_enabled`); only then are predictions
 * accepted. The label must be one of the bands of the subject's grade scale (the subject's own
 * scale, else the grade's) when there is one; without a scale any short label is accepted.
 *
 * Writers: a teacher of the subject in the section, or school leadership. Readers: staff, and the
 * student and their linked parents when the program's visibility is `students_and_parents` — the
 * row filter itself is app.can_read_student_predicted_grade (RLS), so this service never widens it.
 * The teacher's note is staff-only and is withheld from students and parents.
 *
 * Predictions are not results: nothing here is read by finalization, report cards, certificates or
 * transcripts. History lives in app.audit_logs (each save records old and new values).
 */

export const PREDICTED_LABEL_MAX = 40;
export const PREDICTED_NOTE_MAX = 1000;

interface SectionPeriod {
  section: SectionRow;
  subjectName: string;
  year: YearRow;
  program: ProgramRow;
  termId: string | null;
  labels: string[];
  roster: { student_id: string; first_name: string; last_name: string; admission_number: string }[];
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
  if (!term) throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Term not found");
}

/** Scale labels, highest band first, keyed by scale id (null: no scale, free labels). */
async function scaleLabels(
  tx: TransactionSql,
  schoolId: string,
  scaleId: string | null,
  cache?: Map<string, string[]>,
): Promise<string[]> {
  if (!scaleId) return [];
  const cached = cache?.get(scaleId);
  if (cached) return cached;
  const labels = (await loadScale(tx, schoolId, scaleId)).bands.map((band) => band.label);
  cache?.set(scaleId, labels);
  return labels;
}

async function loadSectionPeriod(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
  termId: string | null,
): Promise<SectionPeriod> {
  const section = await requireSectionRow(tx, schoolId, sectionId);
  const subject = await requireEffectiveSubject(tx, schoolId, section, subjectId);
  if (termId !== null) await requireTermInYear(tx, schoolId, section.academic_year_id, termId);
  const year = await requireYear(tx, schoolId, section.academic_year_id);
  const program = await requireProgram(
    tx,
    schoolId,
    section.academic_year_id,
    section.grade_level_id,
  );
  const config = await requireConfig(tx, schoolId, subject.config_id);
  const labels = await scaleLabels(tx, schoolId, config.grade_scale_id ?? program.grade_scale_id);
  const roster = (await loadRoster(tx, schoolId, section, subjectId, subject.requirement)).filter(
    (student) => student.status === "enrolled",
  );
  return {
    section,
    subjectName: subject.subject_name,
    year,
    program,
    termId,
    labels,
    roster: roster.map(({ student_id, first_name, last_name, admission_number }) => ({
      student_id,
      first_name,
      last_name,
      admission_number,
    })),
  };
}

function isYearOpen(year: YearRow): boolean {
  return year.grading_config_status !== "finalized" && year.grading_config_status !== "archived";
}

/** Trimmed text, or null for blank. */
function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// ---------------------------------------------------------------------------
// One section and subject
// ---------------------------------------------------------------------------

export interface SectionPredictedGradesView {
  section_id: string;
  section_name: string;
  grade_level_name: string;
  academic_year_id: string;
  subject_id: string;
  subject_name: string;
  term_id: string | null;
  enabled: boolean;
  visibility: PredictedGradesVisibility;
  editable: boolean;
  labels: string[];
  /** The year's terms, to choose a period from (term_id null is the whole year). */
  terms: { term_id: string; term_name: string }[];
  students: {
    student_id: string;
    first_name: string;
    last_name: string;
    admission_number: string;
    grade_label: string | null;
    note: string | null;
    updated_at: string | null;
  }[];
}

export async function getSectionPredictedGrades(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
  termId: string | null,
): Promise<SectionPredictedGradesView> {
  await assertCanGradeSectionSubject(tx, sectionId, subjectId);
  const period = await loadSectionPeriod(tx, schoolId, sectionId, subjectId, termId);
  const studentIds = period.roster.map((student) => student.student_id);
  const rows = studentIds.length
    ? await tx<
        { student_id: string; grade_label: string; note: string | null; updated_at: Date }[]
      >`
        SELECT student_id, grade_label, note, updated_at
        FROM app.student_predicted_grades
        WHERE school_id = ${schoolId}::uuid
          AND academic_year_id = ${period.section.academic_year_id}::uuid
          AND term_id IS NOT DISTINCT FROM ${termId}::uuid
          AND subject_id = ${subjectId}::uuid
          AND student_id = ANY (${studentIds}::uuid[])
      `
    : [];
  const byStudent = new Map(rows.map((row) => [row.student_id, row]));
  const terms = await loadYearTerms(tx, schoolId, period.section.academic_year_id);
  return {
    section_id: period.section.id,
    section_name: period.section.name,
    grade_level_name: period.section.grade_level_name,
    academic_year_id: period.section.academic_year_id,
    subject_id: subjectId,
    subject_name: period.subjectName,
    term_id: termId,
    enabled: period.program.predicted_grades_enabled,
    visibility: period.program.predicted_grades_visibility,
    editable: period.program.predicted_grades_enabled && isYearOpen(period.year),
    labels: period.labels,
    terms: terms.map((term) => ({ term_id: term.id, term_name: term.name })),
    students: period.roster.map((student) => {
      const row = byStudent.get(student.student_id);
      return {
        ...student,
        grade_label: row?.grade_label ?? null,
        note: row?.note ?? null,
        updated_at: row?.updated_at.toISOString() ?? null,
      };
    }),
  };
}

export interface PredictedGradeInput {
  student_id: string;
  /** null or blank: the prediction is removed. */
  grade_label: string | null;
  /** Omitted: unchanged. null or blank: cleared. */
  note?: string | null;
}

export async function savePredictedGrades(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sectionId: string,
  subjectId: string,
  termId: string | null,
  items: readonly PredictedGradeInput[],
): Promise<{ saved: number; cleared: number }> {
  await assertCanGradeSectionSubject(tx, sectionId, subjectId);
  const period = await loadSectionPeriod(tx, schoolId, sectionId, subjectId, termId);
  if (!period.program.predicted_grades_enabled) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.PREDICTED_GRADES_DISABLED,
      `Predicted grades are not switched on for ${period.section.grade_level_name} this year`,
    );
  }
  assertConfigEditable(period.year);

  const ids = items.map((item) => item.student_id);
  if (new Set(ids).size !== ids.length) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "Each student may appear only once",
    );
  }
  const roster = new Set(period.roster.map((student) => student.student_id));
  const outside = ids.filter((id) => !roster.has(id));
  if (outside.length > 0) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `Not taking this subject in this section: ${outside.slice(0, 5).join(", ")}`,
    );
  }
  const allowed = new Set(period.labels);
  for (const item of items) {
    const label = clean(item.grade_label);
    if (label !== null && allowed.size > 0 && !allowed.has(label)) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `"${label}" is not a grade on this subject's scale (${period.labels.join(", ")})`,
      );
    }
  }

  const yearId = period.section.academic_year_id;
  // One current row per student, subject and period across sections: serialize writers to it so
  // two saves of the same student update one row instead of racing to insert two.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`predicted-grades:${yearId}:${subjectId}:${termId ?? "annual"}`}, 0))`;

  const previous = ids.length
    ? await tx<{ student_id: string; grade_label: string; note: string | null }[]>`
        SELECT student_id, grade_label, note FROM app.student_predicted_grades
        WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
          AND term_id IS NOT DISTINCT FROM ${termId}::uuid AND subject_id = ${subjectId}::uuid
          AND student_id = ANY (${ids}::uuid[])
      `
    : [];
  const before = new Map(previous.map((row) => [row.student_id, row]));

  let saved = 0;
  let cleared = 0;
  const after: Record<string, { grade_label: string; note: string | null } | null> = {};
  for (const item of items) {
    const label = clean(item.grade_label);
    if (label === null) {
      const removed = await tx`
        DELETE FROM app.student_predicted_grades
        WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
          AND term_id IS NOT DISTINCT FROM ${termId}::uuid AND subject_id = ${subjectId}::uuid
          AND student_id = ${item.student_id}::uuid
      `;
      cleared += removed.count;
      after[item.student_id] = null;
      continue;
    }
    const note =
      item.note === undefined ? (before.get(item.student_id)?.note ?? null) : clean(item.note);
    const [updated] = await tx<{ id: string }[]>`
      UPDATE app.student_predicted_grades
      SET grade_label = ${label}, note = ${note}, entered_by_user_id = ${userId}::uuid,
          updated_at = GREATEST(CURRENT_TIMESTAMP, app.student_predicted_grades.created_at)
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
        AND term_id IS NOT DISTINCT FROM ${termId}::uuid AND subject_id = ${subjectId}::uuid
        AND student_id = ${item.student_id}::uuid
      RETURNING id
    `;
    if (!updated) {
      await tx`
        INSERT INTO app.student_predicted_grades (
          school_id, academic_year_id, term_id, student_id, subject_id, grade_label, note,
          entered_by_user_id
        ) VALUES (
          ${schoolId}::uuid, ${yearId}::uuid, ${termId}::uuid, ${item.student_id}::uuid,
          ${subjectId}::uuid, ${label}, ${note}, ${userId}::uuid
        )
      `;
    }
    saved += 1;
    after[item.student_id] = { grade_label: label, note };
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "student_predicted_grades",
    targetId: sectionId,
    oldValues: {
      subject_id: subjectId,
      term_id: termId,
      grades: Object.fromEntries(
        ids.map((id) => {
          const row = before.get(id);
          return [id, row ? { grade_label: row.grade_label, note: row.note } : null];
        }),
      ),
    },
    newValues: { subject_id: subjectId, term_id: termId, grades: after },
  });
  return { saved, cleared };
}

// ---------------------------------------------------------------------------
// One student
// ---------------------------------------------------------------------------

export interface StudentPredictedGradesYear {
  academic_year_id: string;
  academic_year_name: string;
  section_id: string | null;
  section_name: string | null;
  grade_level_name: string | null;
  enabled: boolean;
  visibility: PredictedGradesVisibility;
  /** School leadership, the program enabled and the year still open. */
  can_edit: boolean;
  /** What leadership can predict in (empty unless can_edit). */
  subjects: { subject_id: string; subject_name: string; labels: string[] }[];
  terms: { term_id: string; term_name: string }[];
  grades: {
    term_id: string | null;
    term_name: string | null;
    subject_id: string;
    subject_name: string;
    grade_label: string;
    note: string | null;
    updated_at: string;
  }[];
}

export interface StudentPredictedGradesView {
  student_id: string;
  years: StudentPredictedGradesYear[];
}

interface PlacementRow {
  academic_year_id: string;
  academic_year_name: string;
  starts_on: Date;
  grading_config_status: YearRow["grading_config_status"];
  section_id: string;
  section_name: string;
  grade_level_id: string;
  grade_level_name: string;
  enabled: boolean | null;
  visibility: PredictedGradesVisibility | null;
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

export async function getStudentPredictedGrades(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<StudentPredictedGradesView> {
  const access = await studentAccess(tx, studentId);
  const [student] = await tx<{ id: string }[]>`
    SELECT id FROM app.students WHERE id = ${studentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!student) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Student not found");
  }

  const placements = await tx<PlacementRow[]>`
    SELECT placement.academic_year_id, year.name AS academic_year_name, year.starts_on,
           year.grading_config_status, section.id AS section_id, section.name AS section_name,
           grade.id AS grade_level_id, grade.name AS grade_level_name,
           program.predicted_grades_enabled AS enabled,
           program.predicted_grades_visibility AS visibility
    FROM app.student_sections AS placement
    JOIN app.academic_years AS year
      ON year.id = placement.academic_year_id AND year.school_id = placement.school_id
    JOIN app.sections AS section
      ON section.id = placement.section_id AND section.school_id = placement.school_id
    JOIN app.grade_levels AS grade
      ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    LEFT JOIN app.grade_programs AS program
      ON program.school_id = section.school_id
     AND program.academic_year_id = section.academic_year_id
     AND program.grade_level_id = section.grade_level_id
    WHERE placement.school_id = ${schoolId}::uuid AND placement.student_id = ${studentId}::uuid
  `;
  // RLS (app.can_read_student_predicted_grade) returns only what this caller may read.
  const rows = await tx<
    {
      academic_year_id: string;
      academic_year_name: string;
      starts_on: Date;
      term_id: string | null;
      term_name: string | null;
      term_sequence: number | null;
      subject_id: string;
      subject_name: string;
      grade_label: string;
      note: string | null;
      updated_at: Date;
    }[]
  >`
    SELECT prediction.academic_year_id, year.name AS academic_year_name, year.starts_on,
           prediction.term_id, term.name AS term_name, term.sequence_number AS term_sequence,
           prediction.subject_id, subject.name AS subject_name, prediction.grade_label,
           prediction.note, prediction.updated_at
    FROM app.student_predicted_grades AS prediction
    JOIN app.academic_years AS year
      ON year.id = prediction.academic_year_id AND year.school_id = prediction.school_id
    JOIN app.subjects AS subject
      ON subject.id = prediction.subject_id AND subject.school_id = prediction.school_id
    LEFT JOIN app.terms AS term
      ON term.id = prediction.term_id AND term.school_id = prediction.school_id
    WHERE prediction.school_id = ${schoolId}::uuid AND prediction.student_id = ${studentId}::uuid
    ORDER BY subject.name, term.sequence_number NULLS LAST
  `;

  const placementByYear = new Map(placements.map((row) => [row.academic_year_id, row]));
  const yearIds = new Set(rows.map((row) => row.academic_year_id));
  for (const placement of placements) {
    const shown = access.related
      ? placement.enabled === true && placement.visibility === "students_and_parents"
      : placement.enabled === true;
    if (shown) yearIds.add(placement.academic_year_id);
  }

  const years: (StudentPredictedGradesYear & { starts_on: Date })[] = [];
  const scaleCache = new Map<string, string[]>();
  for (const yearId of yearIds) {
    const placement = placementByYear.get(yearId);
    const first = rows.find((row) => row.academic_year_id === yearId);
    const enabled = placement?.enabled === true;
    const canEdit =
      access.leadership &&
      enabled &&
      placement !== undefined &&
      placement.grading_config_status !== "finalized" &&
      placement.grading_config_status !== "archived";
    years.push({
      academic_year_id: yearId,
      academic_year_name: placement?.academic_year_name ?? first!.academic_year_name,
      starts_on: placement?.starts_on ?? first!.starts_on,
      section_id: placement?.section_id ?? null,
      section_name: placement?.section_name ?? null,
      grade_level_name: placement?.grade_level_name ?? null,
      enabled,
      visibility: placement?.visibility ?? "staff",
      can_edit: canEdit,
      subjects: canEdit
        ? await editableSubjects(tx, schoolId, studentId, placement, scaleCache)
        : [],
      terms: canEdit
        ? (await loadYearTerms(tx, schoolId, yearId)).map((term) => ({
            term_id: term.id,
            term_name: term.name,
          }))
        : [],
      grades: rows
        .filter((row) => row.academic_year_id === yearId)
        .map((row) => ({
          term_id: row.term_id,
          term_name: row.term_name,
          subject_id: row.subject_id,
          subject_name: row.subject_name,
          grade_label: row.grade_label,
          // The teacher's note is staff-only.
          note: access.related ? null : row.note,
          updated_at: row.updated_at.toISOString(),
        })),
    });
  }
  years.sort((a, b) => b.starts_on.getTime() - a.starts_on.getTime());
  return { student_id: studentId, years: years.map(({ starts_on: _starts, ...year }) => year) };
}

/** The subjects the student takes in their section that year, each with its scale's labels. */
async function editableSubjects(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  placement: PlacementRow,
  scaleCache: Map<string, string[]>,
): Promise<StudentPredictedGradesYear["subjects"]> {
  const section: SectionRow = {
    id: placement.section_id,
    name: placement.section_name,
    academic_year_id: placement.academic_year_id,
    grade_level_id: placement.grade_level_id,
    grade_level_name: placement.grade_level_name,
    archived_at: null,
  };
  const program = await requireProgram(
    tx,
    schoolId,
    placement.academic_year_id,
    placement.grade_level_id,
  );
  const choices = await loadSubjectChoices(tx, schoolId, placement.academic_year_id, [studentId]);
  const subjects = (await resolveSectionSubjects(tx, schoolId, section)).filter((subject) => {
    if (subject.config_id === null) return false;
    const choice = choices.get(`${studentId}|${subject.subject_id}`);
    if (choice === "exempt") return false;
    return subject.requirement === "mandatory" || choice === "enrolled";
  });
  const out: StudentPredictedGradesYear["subjects"] = [];
  for (const subject of subjects) {
    const config = await requireConfig(tx, schoolId, subject.config_id!);
    out.push({
      subject_id: subject.subject_id,
      subject_name: subject.subject_name,
      labels: await scaleLabels(
        tx,
        schoolId,
        config.grade_scale_id ?? program.grade_scale_id,
        scaleCache,
      ),
    });
  }
  return out.sort((a, b) => a.subject_name.localeCompare(b.subject_name));
}
