import { ERROR_CODES } from "@studafy/constants";
import { calculateOverallResult, calculateSubjectResult } from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { requireYear } from "./access";
import {
  buildSnapshot,
  loadConfigDetail,
  loadMarks,
  loadRoster,
  loadScale,
  requireProgram,
  requireSectionRow,
  resolveSectionSubjects,
  toEngineConfig,
  toMarkInputs,
} from "./engine-config";

import type { ConfigSnapshot, RosterStudent, SectionRow } from "./engine-config";
import type {
  FailReason,
  MarkInput,
  OverallResult,
  SubjectOutcomeForOverall,
  SubjectResult,
} from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * Results: what the engine says now (preview), what was made official (finalize), and how an
 * official result is corrected (a new version computed with the original rules).
 *
 * Finalization stores, per student and subject, the exact engine configuration used. Reports,
 * certificates and corrections read that snapshot, never the live configuration, so changing next
 * year's (or even this year's) rules cannot rewrite a finalized result.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StudentSubjectComputation {
  subject_id: string;
  subject_name: string;
  subject_code: string;
  config_id: string;
  snapshot: ConfigSnapshot;
  exempt: boolean;
  result: SubjectResult | null;
}

export interface StudentComputation {
  student: { id: string; first_name: string; last_name: string; admission_number: string };
  subjects: StudentSubjectComputation[];
  overall: OverallResult;
}

export interface SectionComputation {
  section: SectionRow;
  term_id: string | null;
  students: StudentComputation[];
  /** Mark sheets for the period(s) not yet approved, as "Subject (term)" labels. */
  unapproved_sheets: string[];
}

export interface FinalizationRow {
  id: string;
  academic_year_id: string;
  section_id: string;
  term_id: string | null;
  version: number;
  status: "finalized" | "superseded";
  finalized_by_user_id: string;
  finalized_at: Date;
  supersedes_id: string | null;
  correction_reason: string | null;
  superseded_at: Date | null;
}

// ---------------------------------------------------------------------------
// Computing a section
// ---------------------------------------------------------------------------

function overallFor(subjects: StudentSubjectComputation[]): OverallResult {
  const outcomes: SubjectOutcomeForOverall[] = subjects.map((subject) => ({
    subjectId: subject.subject_id,
    requirement: subject.snapshot.requirement,
    includeInAverage: subject.snapshot.include_in_average,
    averageWeight: subject.snapshot.average_weight,
    exempt: subject.exempt,
    result: subject.result,
  }));
  const first = subjects[0]?.snapshot.program;
  return calculateOverallResult(outcomes, {
    rounding: first?.rounding ?? { decimals: 2, mode: "half_up" },
    maxFailedSubjectsForSupplementary: first?.max_failed_subjects_for_supplementary ?? 0,
    scale: first?.scale ?? null,
  });
}

/**
 * Run the engine over every student and subject of a section for a term (or the year), using the
 * live configuration. Nothing is stored.
 */
export async function computeSection(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  termId: string | null,
): Promise<SectionComputation> {
  const section = await requireSectionRow(tx, schoolId, sectionId);
  if (termId !== null) {
    const [term] = await tx<{ id: string }[]>`
      SELECT id FROM app.terms
      WHERE id = ${termId}::uuid AND school_id = ${schoolId}::uuid
        AND academic_year_id = ${section.academic_year_id}::uuid
    `;
    if (!term)
      throw new CodedHttpException(
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        "Term not found in this year",
      );
  }
  const program = await requireProgram(
    tx,
    schoolId,
    section.academic_year_id,
    section.grade_level_id,
  );
  const programScale = (await loadScale(tx, schoolId, program.grade_scale_id)).bands;
  const subjects = (await resolveSectionSubjects(tx, schoolId, section)).filter(
    (subject) => subject.config_id !== null,
  );

  const placed = await tx<
    { id: string; first_name: string; last_name: string; admission_number: string }[]
  >`
    SELECT student.id, student.first_name, student.last_name, student.admission_number
    FROM app.student_sections AS placement
    JOIN app.students AS student ON student.id = placement.student_id AND student.school_id = placement.school_id
    WHERE placement.school_id = ${schoolId}::uuid AND placement.section_id = ${sectionId}::uuid
    ORDER BY student.last_name, student.first_name, student.id
  `;
  const perStudent = new Map<string, StudentSubjectComputation[]>(placed.map((s) => [s.id, []]));
  const unapproved: string[] = [];
  const sheets = await tx<{ subject_id: string; term_id: string | null; status: string }[]>`
    SELECT subject_id, term_id, status FROM app.mark_sheets
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
  `;
  const terms = await tx<{ id: string; name: string }[]>`
    SELECT id, name FROM app.terms WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${section.academic_year_id}::uuid
  `;

  for (const subject of subjects) {
    const loaded = await loadConfigDetail(tx, schoolId, subject.config_id!);
    const engine = toEngineConfig(loaded, { sectionId });
    // A term report covers the subjects graded in that term; an annual-only subject has nothing to
    // report for a term and must not make every student's term result incomplete.
    if (termId !== null && !engine.assessments.some((assessment) => assessment.termId === termId)) {
      continue;
    }
    const snapshot = buildSnapshot(loaded, subject.source, engine, program, programScale);
    const roster: RosterStudent[] = await loadRoster(
      tx,
      schoolId,
      section,
      subject.subject_id,
      subject.requirement,
    );

    // Every period that feeds this computation needs an approved sheet (when approval is on).
    const periods = new Set(
      engine.assessments
        .filter((assessment) =>
          termId === null
            ? engine.method === "total_points" ||
              assessment.termId === null ||
              (engine.terms.find((term) => term.termId === assessment.termId)?.weight ?? 0) > 0
            : assessment.termId === termId,
        )
        .map((assessment) => assessment.termId),
    );
    for (const period of periods) {
      const sheet = sheets.find((s) => s.subject_id === subject.subject_id && s.term_id === period);
      if (sheet?.status !== "approved") {
        const label =
          period === null ? "annual" : (terms.find((t) => t.id === period)?.name ?? "term");
        unapproved.push(`${subject.subject_name} (${label})`);
      }
    }

    const marks = await loadMarks(
      tx,
      schoolId,
      engine.assessments.map((assessment) => assessment.id),
      roster.map((student) => student.student_id),
    );
    for (const student of roster) {
      const list = perStudent.get(student.student_id);
      if (!list) continue;
      const exempt = student.status === "exempt";
      list.push({
        subject_id: subject.subject_id,
        subject_name: subject.subject_name,
        subject_code: subject.subject_code,
        config_id: subject.config_id!,
        snapshot,
        exempt,
        result: exempt
          ? null
          : calculateSubjectResult(
              engine,
              toMarkInputs(marks, student.student_id),
              termId === null ? {} : { termId },
            ),
      });
    }
  }

  return {
    section,
    term_id: termId,
    unapproved_sheets: program.mark_approval_required ? unapproved : [],
    students: placed.map((student) => {
      const subjectsOfStudent = perStudent.get(student.id) ?? [];
      return {
        student: {
          id: student.id,
          first_name: student.first_name,
          last_name: student.last_name,
          admission_number: student.admission_number,
        },
        subjects: subjectsOfStudent,
        overall: overallFor(subjectsOfStudent),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

const FINALIZATION_COLUMNS = `
  id, academic_year_id, section_id, term_id, version, status, finalized_by_user_id, finalized_at,
  supersedes_id, correction_reason, superseded_at`;

async function currentFinalization(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  termId: string | null,
): Promise<FinalizationRow | undefined> {
  const [row] = await tx<FinalizationRow[]>`
    SELECT ${tx.unsafe(FINALIZATION_COLUMNS)} FROM app.result_finalizations
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
      AND term_id IS NOT DISTINCT FROM ${termId}::uuid AND status = 'finalized'
  `;
  return row;
}

async function storeComputation(
  tx: TransactionSql,
  schoolId: string,
  finalizationId: string,
  students: StudentComputation[],
): Promise<void> {
  for (const student of students) {
    for (const subject of student.subjects) {
      const result = subject.result;
      const status = subject.exempt
        ? "exempt"
        : result?.status === "complete"
          ? "complete"
          : "incomplete";
      await tx`
        INSERT INTO app.student_subject_results (
          school_id, finalization_id, student_id, subject_id, subject_config_id, status, percentage,
          marks_obtained, max_marks, grade_label, gpa_points, passed, include_in_average,
          include_on_certificate, config_snapshot, breakdown
        ) VALUES (
          ${schoolId}::uuid, ${finalizationId}::uuid, ${student.student.id}::uuid,
          ${subject.subject_id}::uuid, ${subject.config_id}::uuid, ${status},
          ${status === "complete" ? result!.percentage : null},
          ${status === "complete" ? result!.marksObtained : null},
          ${subject.snapshot.engine.maxMarks},
          ${status === "complete" ? result!.gradeLabel : null},
          ${status === "complete" ? result!.gpaPoints : null},
          ${status === "complete" ? result!.passed : null},
          ${subject.snapshot.include_in_average}, ${subject.snapshot.include_on_certificate},
          ${tx.json(subject.snapshot as never)}, ${tx.json((result ?? { exempt: true }) as never)}
        )
      `;
    }
    const overall = student.overall;
    await tx`
      INSERT INTO app.student_overall_results (
        school_id, finalization_id, student_id, status, average_percentage, total_obtained,
        total_max, grade_label, subjects_failed, academic_status
      ) VALUES (
        ${schoolId}::uuid, ${finalizationId}::uuid, ${student.student.id}::uuid, ${overall.status},
        ${overall.averagePercentage}, ${overall.totalObtained}, ${overall.totalMax},
        ${overall.gradeLabel}, ${overall.subjectsFailed}, ${overall.academicStatus}
      )
    `;
  }
}

function incompleteSummary(students: StudentComputation[]): string[] {
  return students
    .filter((student) => student.overall.status === "incomplete")
    .map((student) => {
      const subjects = student.subjects
        .filter((subject) => !subject.exempt && subject.result?.status !== "complete")
        .map((subject) => subject.subject_name);
      return `${student.student.first_name} ${student.student.last_name} (${subjects.join(", ")})`;
    });
}

/**
 * Make a section's term or annual results official. Refused while any contributing mark sheet
 * awaits approval, or while any student's result is incomplete unless `allowIncomplete` — in which
 * case those students are finalized as incomplete (no grade, no certificate) and stay identifiable.
 */
export async function finalizeSection(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sectionId: string,
  termId: string | null,
  options: { allowIncomplete: boolean },
): Promise<FinalizationRow> {
  // Serialize finalization of one section.
  await tx`SELECT id FROM app.sections WHERE id = ${sectionId}::uuid AND school_id = ${schoolId}::uuid FOR UPDATE`;
  const computation = await computeSection(tx, schoolId, sectionId, termId);
  const year = await requireYear(tx, schoolId, computation.section.academic_year_id);
  if (year.grading_config_status !== "active") {
    throw new CodedHttpException(
      409,
      year.grading_config_status === "draft"
        ? ERROR_CODES.ACADEMIC_YEAR_NOT_ACTIVE
        : ERROR_CODES.ACADEMIC_CONFIG_LOCKED,
      "Results can only be finalized while the year's grading configuration is active",
    );
  }
  if (await currentFinalization(tx, schoolId, sectionId, termId)) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RESULTS_ALREADY_FINALIZED,
      "These results are already finalized. Use the correction workflow to change them.",
    );
  }
  if (computation.students.length === 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RESULTS_INCOMPLETE,
      "This section has no students",
    );
  }
  if (computation.unapproved_sheets.length > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RESULTS_INCOMPLETE,
      `Mark sheets awaiting approval: ${computation.unapproved_sheets.join(", ")}`,
    );
  }
  const incomplete = incompleteSummary(computation.students);
  if (incomplete.length > 0 && !options.allowIncomplete) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RESULTS_INCOMPLETE,
      `Incomplete results: ${incomplete.slice(0, 10).join("; ")}${incomplete.length > 10 ? ` and ${incomplete.length - 10} more` : ""}`,
    );
  }

  const [finalization] = await tx<FinalizationRow[]>`
    INSERT INTO app.result_finalizations (school_id, academic_year_id, section_id, term_id, finalized_by_user_id)
    VALUES (${schoolId}::uuid, ${computation.section.academic_year_id}::uuid, ${sectionId}::uuid,
            ${termId}::uuid, ${userId}::uuid)
    RETURNING ${tx.unsafe(FINALIZATION_COLUMNS)}
  `;
  await storeComputation(tx, schoolId, finalization!.id, computation.students);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "result_finalizations",
    targetId: finalization!.id,
    newValues: {
      section_id: sectionId,
      term_id: termId,
      students: computation.students.length,
      incomplete_students: incomplete.length,
    },
  });
  return finalization!;
}

export interface CorrectionInput {
  reason: string;
  marks: {
    assessment_id: string;
    student_id: string;
    attempt: 1 | 2;
    status: MarkInput["status"] | "pending";
    score: number | null;
  }[];
  allow_incomplete: boolean;
}

/**
 * The authorized correction of finalized results.
 *
 * Applies the corrected marks (audited, and only for students and assessments in the finalization),
 * then recomputes every student with the configuration snapshot stored in the finalization being
 * corrected — not with whatever the configuration is today — and writes version n+1, superseding
 * the old one. Certificates issued from the old version stay as issued; they show as needing
 * reissue until an administrator reissues them.
 */
export async function correctFinalization(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  finalizationId: string,
  input: CorrectionInput,
): Promise<FinalizationRow> {
  const [old] = await tx<FinalizationRow[]>`
    SELECT ${tx.unsafe(FINALIZATION_COLUMNS)} FROM app.result_finalizations
    WHERE id = ${finalizationId}::uuid AND school_id = ${schoolId}::uuid
    FOR UPDATE
  `;
  if (!old)
    throw new CodedHttpException(
      404,
      ERROR_CODES.RESULT_FINALIZATION_NOT_FOUND,
      "Finalized results not found",
    );
  if (old.status !== "finalized") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "Only the current version of results can be corrected",
    );
  }
  const year = await requireYear(tx, schoolId, old.academic_year_id);
  if (year.grading_config_status === "archived") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ACADEMIC_CONFIG_LOCKED,
      "This academic year is archived",
    );
  }

  const stored = await tx<
    { student_id: string; subject_id: string; status: string; config_snapshot: ConfigSnapshot }[]
  >`
    SELECT student_id, subject_id, status, config_snapshot
    FROM app.student_subject_results
    WHERE school_id = ${schoolId}::uuid AND finalization_id = ${finalizationId}::uuid
  `;
  const students = await tx<
    { id: string; first_name: string; last_name: string; admission_number: string }[]
  >`
    SELECT student.id, student.first_name, student.last_name, student.admission_number
    FROM app.student_overall_results AS overall
    JOIN app.students AS student ON student.id = overall.student_id AND student.school_id = overall.school_id
    WHERE overall.school_id = ${schoolId}::uuid AND overall.finalization_id = ${finalizationId}::uuid
    ORDER BY student.last_name, student.first_name, student.id
  `;

  // Only marks the finalization actually covers can be corrected through it.
  const allowedAssessments = new Map<string, ConfigSnapshot>();
  for (const row of stored) {
    for (const assessment of row.config_snapshot.engine.assessments) {
      allowedAssessments.set(`${row.student_id}|${assessment.id}`, row.config_snapshot);
    }
  }
  const changes: unknown[] = [];
  await tx`SELECT set_config('app.result_correction', 'on', true)`;
  for (const mark of input.marks) {
    const snapshot = allowedAssessments.get(`${mark.student_id}|${mark.assessment_id}`);
    if (!snapshot) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        "A corrected mark is not part of these finalized results",
      );
    }
    const assessment = snapshot.engine.assessments.find((a) => a.id === mark.assessment_id)!;
    if (
      mark.status === "graded" &&
      (mark.score === null || mark.score < 0 || mark.score > assessment.maxMarks)
    ) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.MARK_SCORE_OUT_OF_RANGE,
        `${assessment.name}: a mark must be between 0 and ${assessment.maxMarks}`,
      );
    }
    if (mark.status !== "graded" && mark.score !== null) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        "Only a graded mark carries a score",
      );
    }
    const [before] = await tx<{ status: string; score: string | null }[]>`
      SELECT status, score FROM app.student_marks
      WHERE school_id = ${schoolId}::uuid AND assessment_id = ${mark.assessment_id}::uuid
        AND student_id = ${mark.student_id}::uuid AND attempt = ${mark.attempt}
    `;
    if (mark.status === "pending") {
      await tx`
        DELETE FROM app.student_marks
        WHERE school_id = ${schoolId}::uuid AND assessment_id = ${mark.assessment_id}::uuid
          AND student_id = ${mark.student_id}::uuid AND attempt = ${mark.attempt}
      `;
    } else {
      await tx`
        INSERT INTO app.student_marks (
          school_id, academic_year_id, assessment_id, student_id, attempt, status, score, entered_by_user_id
        ) VALUES (
          ${schoolId}::uuid, ${old.academic_year_id}::uuid, ${mark.assessment_id}::uuid,
          ${mark.student_id}::uuid, ${mark.attempt}, ${mark.status}, ${mark.score}, ${userId}::uuid
        )
        ON CONFLICT (school_id, assessment_id, student_id, attempt) DO UPDATE SET
          status = EXCLUDED.status, score = EXCLUDED.score,
          entered_by_user_id = EXCLUDED.entered_by_user_id, updated_at = CURRENT_TIMESTAMP
      `;
    }
    changes.push({ ...mark, old: before ?? null });
  }
  await tx`SELECT set_config('app.result_correction', 'off', true)`;

  // Recompute every student with the stored snapshots.
  const assessmentIds = [
    ...new Set(stored.flatMap((row) => row.config_snapshot.engine.assessments.map((a) => a.id))),
  ];
  const marks = await loadMarks(
    tx,
    schoolId,
    assessmentIds,
    students.map((student) => student.id),
  );
  const recomputed: StudentComputation[] = students.map((student) => {
    const subjects: StudentSubjectComputation[] = stored
      .filter((row) => row.student_id === student.id)
      .map((row) => {
        const snapshot = row.config_snapshot;
        const exempt = row.status === "exempt";
        const own = toMarkInputs(marks, student.id).filter((mark) =>
          snapshot.engine.assessments.some((assessment) => assessment.id === mark.assessmentId),
        );
        return {
          subject_id: row.subject_id,
          subject_name: snapshot.subject.name,
          subject_code: snapshot.subject.code,
          config_id: snapshot.subject_config_id,
          snapshot,
          exempt,
          result: exempt
            ? null
            : calculateSubjectResult(
                snapshot.engine,
                own,
                old.term_id === null ? {} : { termId: old.term_id },
              ),
        };
      })
      .sort((a, b) => a.subject_name.localeCompare(b.subject_name));
    return { student, subjects, overall: overallFor(subjects) };
  });

  const incomplete = incompleteSummary(recomputed);
  if (incomplete.length > 0 && !input.allow_incomplete) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RESULTS_INCOMPLETE,
      `The corrected results would be incomplete: ${incomplete.slice(0, 10).join("; ")}`,
    );
  }

  await tx`
    UPDATE app.result_finalizations SET status = 'superseded'
    WHERE id = ${finalizationId}::uuid AND school_id = ${schoolId}::uuid
  `;
  const [next] = await tx<FinalizationRow[]>`
    INSERT INTO app.result_finalizations (
      school_id, academic_year_id, section_id, term_id, version, finalized_by_user_id,
      supersedes_id, correction_reason
    ) VALUES (
      ${schoolId}::uuid, ${old.academic_year_id}::uuid, ${old.section_id}::uuid, ${old.term_id}::uuid,
      ${old.version + 1}, ${userId}::uuid, ${finalizationId}::uuid, ${input.reason}
    )
    RETURNING ${tx.unsafe(FINALIZATION_COLUMNS)}
  `;
  await storeComputation(tx, schoolId, next!.id, recomputed);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "result_finalizations",
    targetId: next!.id,
    oldValues: { finalization_id: finalizationId, version: old.version },
    newValues: { version: old.version + 1, reason: input.reason, mark_changes: changes },
  });
  return next!;
}

// ---------------------------------------------------------------------------
// Reading results
// ---------------------------------------------------------------------------

export interface StoredSubjectResult {
  subject_id: string;
  subject_code: string;
  subject_name: string;
  status: "complete" | "incomplete" | "exempt";
  percentage: number | null;
  marks_obtained: number | null;
  max_marks: number;
  grade_label: string | null;
  gpa_points: number | null;
  passed: boolean | null;
  include_in_average: boolean;
  include_on_certificate: boolean;
  requirement: string;
  terms: { term_id: string | null; percentage: number | null }[];
  fail_reasons: FailReason[];
}

export interface StoredStudentResult {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_number: string;
  status: "complete" | "incomplete";
  average_percentage: number | null;
  total_obtained: number | null;
  total_max: number | null;
  grade_label: string | null;
  subjects_failed: number;
  academic_status: "promoted" | "supplementary" | "retained" | "incomplete";
  subjects: StoredSubjectResult[];
}

const n = (value: string | null): number | null => (value === null ? null : Number(value));

export async function readFinalizationResults(
  tx: TransactionSql,
  schoolId: string,
  finalizationId: string,
  filter: { studentId?: string } = {},
): Promise<StoredStudentResult[]> {
  const studentFilter = filter.studentId
    ? tx`AND overall.student_id = ${filter.studentId}::uuid`
    : tx``;
  const overall = await tx<
    {
      student_id: string;
      first_name: string;
      last_name: string;
      admission_number: string;
      status: "complete" | "incomplete";
      average_percentage: string | null;
      total_obtained: string | null;
      total_max: string | null;
      grade_label: string | null;
      subjects_failed: number;
      academic_status: StoredStudentResult["academic_status"];
    }[]
  >`
    SELECT overall.student_id, student.first_name, student.last_name, student.admission_number,
           overall.status, overall.average_percentage, overall.total_obtained, overall.total_max,
           overall.grade_label, overall.subjects_failed, overall.academic_status
    FROM app.student_overall_results AS overall
    JOIN app.students AS student ON student.id = overall.student_id AND student.school_id = overall.school_id
    WHERE overall.school_id = ${schoolId}::uuid AND overall.finalization_id = ${finalizationId}::uuid
      ${studentFilter}
    ORDER BY student.last_name, student.first_name, student.id
  `;
  const subjectFilter = filter.studentId
    ? tx`AND result.student_id = ${filter.studentId}::uuid`
    : tx``;
  const subjects = await tx<
    {
      student_id: string;
      subject_id: string;
      status: StoredSubjectResult["status"];
      percentage: string | null;
      marks_obtained: string | null;
      max_marks: string;
      grade_label: string | null;
      gpa_points: string | null;
      passed: boolean | null;
      include_in_average: boolean;
      include_on_certificate: boolean;
      config_snapshot: ConfigSnapshot;
      breakdown: Partial<SubjectResult>;
    }[]
  >`
    SELECT result.student_id, result.subject_id, result.status, result.percentage,
           result.marks_obtained, result.max_marks, result.grade_label, result.gpa_points,
           result.passed, result.include_in_average, result.include_on_certificate,
           result.config_snapshot, result.breakdown
    FROM app.student_subject_results AS result
    WHERE result.school_id = ${schoolId}::uuid AND result.finalization_id = ${finalizationId}::uuid
      ${subjectFilter}
  `;
  return overall.map((row) => ({
    student_id: row.student_id,
    first_name: row.first_name,
    last_name: row.last_name,
    admission_number: row.admission_number,
    status: row.status,
    average_percentage: n(row.average_percentage),
    total_obtained: n(row.total_obtained),
    total_max: n(row.total_max),
    grade_label: row.grade_label,
    subjects_failed: row.subjects_failed,
    academic_status: row.academic_status,
    subjects: subjects
      .filter((subject) => subject.student_id === row.student_id)
      .map((subject) => ({
        subject_id: subject.subject_id,
        // Names come from the snapshot: what the subject was called when the result was made.
        subject_code: subject.config_snapshot.subject.code,
        subject_name: subject.config_snapshot.subject.name,
        status: subject.status,
        percentage: n(subject.percentage),
        marks_obtained: n(subject.marks_obtained),
        max_marks: Number(subject.max_marks),
        grade_label: subject.grade_label,
        gpa_points: n(subject.gpa_points),
        passed: subject.passed,
        include_in_average: subject.include_in_average,
        include_on_certificate: subject.include_on_certificate,
        requirement: subject.config_snapshot.requirement,
        terms: (subject.breakdown.terms ?? []).map((term) => ({
          term_id: term.termId,
          percentage: term.percentage,
        })),
        fail_reasons: subject.breakdown.failReasons ?? [],
      }))
      .sort((a, b) => a.subject_name.localeCompare(b.subject_name)),
  }));
}

export async function requireFinalization(
  tx: TransactionSql,
  schoolId: string,
  finalizationId: string,
): Promise<FinalizationRow> {
  const [row] = await tx<FinalizationRow[]>`
    SELECT ${tx.unsafe(FINALIZATION_COLUMNS)} FROM app.result_finalizations
    WHERE id = ${finalizationId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!row)
    throw new CodedHttpException(
      404,
      ERROR_CODES.RESULT_FINALIZATION_NOT_FOUND,
      "Finalized results not found",
    );
  return row;
}

export async function listFinalizations(
  tx: TransactionSql,
  schoolId: string,
  filter: { yearId?: string; sectionId?: string },
): Promise<
  (FinalizationRow & { section_name: string; grade_level_name: string; term_name: string | null })[]
> {
  const yearFilter = filter.yearId
    ? tx`AND finalization.academic_year_id = ${filter.yearId}::uuid`
    : tx``;
  const sectionFilter = filter.sectionId
    ? tx`AND finalization.section_id = ${filter.sectionId}::uuid`
    : tx``;
  return tx`
    SELECT finalization.id, finalization.academic_year_id, finalization.section_id,
           finalization.term_id, finalization.version, finalization.status,
           finalization.finalized_by_user_id, finalization.finalized_at, finalization.supersedes_id,
           finalization.correction_reason, finalization.superseded_at,
           section.name AS section_name, grade.name AS grade_level_name, term.name AS term_name
    FROM app.result_finalizations AS finalization
    JOIN app.sections AS section ON section.id = finalization.section_id AND section.school_id = finalization.school_id
    JOIN app.grade_levels AS grade ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    LEFT JOIN app.terms AS term ON term.id = finalization.term_id AND term.school_id = finalization.school_id
    WHERE finalization.school_id = ${schoolId}::uuid
      ${yearFilter}
      ${sectionFilter}
    ORDER BY grade.sort_order, section.name, finalization.term_id NULLS LAST, finalization.version DESC
  `;
}

/** A student's (or a linked parent's) view: every current finalized result, newest year first. */
export async function listStudentResults(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<
  {
    finalization_id: string;
    academic_year_id: string;
    academic_year_name: string;
    section_name: string;
    grade_level_name: string;
    term_id: string | null;
    term_name: string | null;
    version: number;
    finalized_at: string;
    result: StoredStudentResult;
  }[]
> {
  const finalizations = await tx<
    {
      id: string;
      academic_year_id: string;
      academic_year_name: string;
      section_name: string;
      grade_level_name: string;
      term_id: string | null;
      term_name: string | null;
      version: number;
      finalized_at: Date;
    }[]
  >`
    SELECT finalization.id, finalization.academic_year_id, year.name AS academic_year_name,
           section.name AS section_name, grade.name AS grade_level_name, finalization.term_id,
           term.name AS term_name, finalization.version, finalization.finalized_at
    FROM app.student_overall_results AS overall
    JOIN app.result_finalizations AS finalization
      ON finalization.id = overall.finalization_id AND finalization.school_id = overall.school_id
    JOIN app.academic_years AS year ON year.id = finalization.academic_year_id AND year.school_id = finalization.school_id
    JOIN app.sections AS section ON section.id = finalization.section_id AND section.school_id = finalization.school_id
    JOIN app.grade_levels AS grade ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    LEFT JOIN app.terms AS term ON term.id = finalization.term_id AND term.school_id = finalization.school_id
    WHERE overall.school_id = ${schoolId}::uuid AND overall.student_id = ${studentId}::uuid
      AND finalization.status = 'finalized'
    ORDER BY year.starts_on DESC, term.sequence_number NULLS LAST
  `;
  const out = [];
  for (const finalization of finalizations) {
    const [result] = await readFinalizationResults(tx, schoolId, finalization.id, { studentId });
    if (!result) continue;
    out.push({
      ...finalization,
      finalized_at: finalization.finalized_at.toISOString(),
      result,
      finalization_id: finalization.id,
    });
  }
  return out.map(({ id: _id, ...rest }) => rest);
}

/** Preview payload for the admin: what finalizing now would produce. */
export function computationView(computation: SectionComputation) {
  return {
    section_id: computation.section.id,
    term_id: computation.term_id,
    unapproved_sheets: computation.unapproved_sheets,
    ready:
      computation.unapproved_sheets.length === 0 &&
      computation.students.every((s) => s.overall.status === "complete"),
    students: computation.students.map((student) => ({
      student_id: student.student.id,
      first_name: student.student.first_name,
      last_name: student.student.last_name,
      admission_number: student.student.admission_number,
      status: student.overall.status,
      average_percentage: student.overall.averagePercentage,
      total_obtained: student.overall.totalObtained,
      total_max: student.overall.totalMax,
      grade_label: student.overall.gradeLabel,
      subjects_failed: student.overall.subjectsFailed,
      academic_status: student.overall.academicStatus,
      subjects: student.subjects.map((subject) => ({
        subject_id: subject.subject_id,
        subject_name: subject.subject_name,
        exempt: subject.exempt,
        status: subject.exempt
          ? ("exempt" as const)
          : (subject.result?.status ?? ("incomplete" as const)),
        percentage: subject.result?.percentage ?? null,
        provisional_percentage:
          subject.result?.provisionalPercentage == null
            ? null
            : Math.round(subject.result.provisionalPercentage * 100) / 100,
        marks_obtained: subject.result?.marksObtained ?? null,
        max_marks: subject.snapshot.engine.maxMarks,
        grade_label: subject.result?.gradeLabel ?? null,
        passed: subject.result?.passed ?? null,
        missing_assessments: subject.result?.missingAssessments.map((m) => m.name) ?? [],
      })),
    })),
  };
}
