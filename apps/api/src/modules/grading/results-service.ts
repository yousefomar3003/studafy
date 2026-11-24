import { ERROR_CODES } from "@studafy/constants";
import { calculateOverallResult, calculateSubjectResult } from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import {
  readOutcomeSnapshot,
  snapshotOutcomeAchievements,
} from "../academic-planning/report-snapshot";

import { requireYear } from "./access";
import { attachClassRanks } from "./class-rank-service";
import { diplomaView, loadFinalDiplomaCore, storedDiploma } from "./diploma-service";
import {
  buildSnapshot,
  effectiveSubjects,
  loadConfigDetails,
  loadMarks,
  loadPlacements,
  loadSubjectChoices,
  loadYearConfigs,
  requireSectionRow,
  rosterFrom,
  sectionConfigs,
  toEngineConfig,
  toMarkInputs,
} from "./engine-config";
import { readReportNotes, snapshotReportNotes } from "./report-card-service";

import type { ClassRank, RankAudience } from "./class-rank-service";
import type { DiplomaResultView } from "./diploma-service";
import type {
  ConfigDetails,
  ConfigSnapshot,
  MarkRow,
  PlacedStudent,
  RosterStudent,
  SectionRow,
  SubjectConfigRow,
} from "./engine-config";
import type { ReportNotes } from "./report-card-service";
import type { OutcomeAchievementView } from "../academic-planning/report-snapshot";
import type {
  DiplomaCoreInput,
  FailReason,
  MarkInput,
  OverallResult,
  ResultDisplay,
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

/**
 * A student's overall result from their subjects. `core` is the student's final IB Diploma core
 * grades (TOK, EE, CAS); only a points_total grade reads them (see diploma-service).
 */
function overallFor(subjects: StudentSubjectComputation[], core?: DiplomaCoreInput): OverallResult {
  const outcomes: SubjectOutcomeForOverall[] = subjects.map((subject) => ({
    subjectId: subject.subject_id,
    requirement: subject.snapshot.requirement,
    includeInAverage: subject.snapshot.include_in_average,
    averageWeight: subject.snapshot.average_weight,
    credits: subject.snapshot.credits ?? null,
    courseLevel: subject.snapshot.course_level ?? null,
    exempt: subject.exempt,
    result: subject.result,
  }));
  const first = subjects[0]?.snapshot.program;
  return calculateOverallResult(
    outcomes,
    {
      rounding: first?.rounding ?? { decimals: 2, mode: "half_up" },
      maxFailedSubjectsForSupplementary: first?.max_failed_subjects_for_supplementary ?? 0,
      scale: first?.scale ?? null,
      resultFormat: first?.result_format,
      ...(first?.diploma ? { diploma: first.diploma } : {}),
    },
    core,
  );
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
  const data = await loadSectionsGradingData(tx, schoolId, section.academic_year_id, [section]);
  return computeLoadedSection(data, section, termId);
}

/** Everything {@link computeLoadedSection} reads, for every section of one year it will compute. */
export interface SectionsGradingData {
  configs: SubjectConfigRow[];
  details: ConfigDetails;
  placements: Map<string, PlacedStudent[]>;
  choices: Map<string, string>;
  marksByStudent: Map<string, MarkRow[]>;
  sheets: Map<string, { subject_id: string; term_id: string | null; status: string }[]>;
  /** Final IB Diploma core grades by student (000262); read only by points_total grades. */
  diplomaCore: Map<string, DiplomaCoreInput>;
}

/**
 * Load, in a fixed number of queries, the configuration, rosters, marks and mark sheets of some
 * sections of one year — instead of a round of queries per section and subject.
 */
export async function loadSectionsGradingData(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  sections: readonly Pick<SectionRow, "id" | "grade_level_id">[],
  /** The year's configs and their details when the caller already has them (any superset). */
  preloaded?: Pick<SectionsGradingData, "configs" | "details">,
): Promise<SectionsGradingData> {
  const sectionIds = sections.map((section) => section.id);
  const configs =
    preloaded?.configs ??
    (await loadYearConfigs(tx, schoolId, yearId, {
      gradeLevelIds: [...new Set(sections.map((section) => section.grade_level_id))],
      sectionIds,
    }));
  const [details, placements, sheetRows] = await Promise.all([
    preloaded?.details ?? loadConfigDetails(tx, schoolId, yearId, configs),
    loadPlacements(tx, schoolId, sectionIds),
    sectionIds.length === 0
      ? Promise.resolve(
          [] as {
            section_id: string;
            subject_id: string;
            term_id: string | null;
            status: string;
          }[],
        )
      : tx<{ section_id: string; subject_id: string; term_id: string | null; status: string }[]>`
          SELECT section_id, subject_id, term_id, status FROM app.mark_sheets
          WHERE school_id = ${schoolId}::uuid AND section_id = ANY (${sectionIds}::uuid[])
        `,
  ]);
  const studentIds = [...placements.values()].flat().map((student) => student.student_id);
  const assessmentIds = details.assessments
    .filter((assessment) => assessment.status === "active")
    .map((assessment) => assessment.id);
  const [choices, marks, diplomaCore] = await Promise.all([
    loadSubjectChoices(tx, schoolId, yearId, studentIds),
    loadMarks(tx, schoolId, assessmentIds, studentIds),
    loadFinalDiplomaCore(tx, schoolId, yearId, studentIds),
  ]);
  const marksByStudent = new Map<string, MarkRow[]>();
  for (const mark of marks) {
    const list = marksByStudent.get(mark.student_id);
    if (list) list.push(mark);
    else marksByStudent.set(mark.student_id, [mark]);
  }
  const sheets = new Map<
    string,
    { subject_id: string; term_id: string | null; status: string }[]
  >();
  for (const { section_id, ...sheet } of sheetRows) {
    const list = sheets.get(section_id);
    if (list) list.push(sheet);
    else sheets.set(section_id, [sheet]);
  }
  return { configs, details, placements, choices, marksByStudent, sheets, diplomaCore };
}

/** {@link computeSection} over loaded data: no queries. */
export function computeLoadedSection(
  data: SectionsGradingData,
  section: SectionRow,
  termId: string | null,
): SectionComputation {
  const sectionId = section.id;
  const program = data.details.program(section.grade_level_id);
  const programScale = data.details.scale(program.grade_scale_id).bands;
  const subjects = effectiveSubjects(sectionConfigs(data.configs, section)).filter(
    (subject) => subject.config_id !== null,
  );

  const placed = data.placements.get(sectionId) ?? [];
  const perStudent = new Map<string, StudentSubjectComputation[]>(
    placed.map((s) => [s.student_id, []]),
  );
  const unapproved: string[] = [];
  const sheets = data.sheets.get(sectionId) ?? [];
  const terms = data.details.terms;

  for (const subject of subjects) {
    const loaded = data.details.get(subject.config_id!);
    const engine = toEngineConfig(loaded, { sectionId });
    // A term report covers the subjects graded in that term; an annual-only subject has nothing to
    // report for a term and must not make every student's term result incomplete.
    if (termId !== null && !engine.assessments.some((assessment) => assessment.termId === termId)) {
      continue;
    }
    const snapshot = buildSnapshot(loaded, subject.source, engine, program, programScale);
    const roster: RosterStudent[] = rosterFrom(
      placed,
      data.choices,
      subject.subject_id,
      subject.requirement,
    );

    // Every period that feeds this computation needs an approved sheet (when approval is on).
    const periods = new Set(
      engine.assessments
        .filter((assessment) =>
          termId === null
            ? // Total-points and descriptive subjects count every term; weighted ones only weighted terms.
              engine.method !== "weighted" ||
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

    const assessmentIds = new Set(engine.assessments.map((assessment) => assessment.id));
    for (const student of roster) {
      const list = perStudent.get(student.student_id);
      if (!list) continue;
      const exempt = student.status === "exempt";
      const marks = (data.marksByStudent.get(student.student_id) ?? []).filter((mark) =>
        assessmentIds.has(mark.assessment_id),
      );
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
      const subjectsOfStudent = perStudent.get(student.student_id) ?? [];
      return {
        student: {
          id: student.student_id,
          first_name: student.first_name,
          last_name: student.last_name,
          admission_number: student.admission_number,
        },
        subjects: subjectsOfStudent,
        overall: overallFor(subjectsOfStudent, data.diplomaCore.get(student.student_id)),
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

/** Rows per multi-row INSERT: snapshots are a few KB each, so this bounds one statement's payload. */
const STORE_CHUNK = 200;

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Write a computation's per-subject and overall rows: a few multi-row INSERTs per section
 * (jsonb_to_recordset, like the attendance batch) instead of one INSERT per student and subject.
 * Values are the same JS values the per-row INSERTs sent; numbers travel as JSON text, which
 * Postgres parses exactly as it parsed the text parameters.
 */
async function storeComputation(
  tx: TransactionSql,
  schoolId: string,
  finalizationId: string,
  students: StudentComputation[],
): Promise<void> {
  const subjectRows = students.flatMap((student) =>
    student.subjects.map((subject) => {
      const result = subject.result;
      const status = subject.exempt
        ? "exempt"
        : result?.status === "complete"
          ? "complete"
          : "incomplete";
      return {
        student_id: student.student.id,
        subject_id: subject.subject_id,
        subject_config_id: subject.config_id,
        status,
        percentage: status === "complete" ? result!.percentage : null,
        marks_obtained: status === "complete" ? result!.marksObtained : null,
        max_marks: subject.snapshot.engine.maxMarks,
        grade_label: status === "complete" ? result!.gradeLabel : null,
        gpa_points: status === "complete" ? result!.gpaPoints : null,
        weighted_gpa_points: status === "complete" ? (result!.weightedGpaPoints ?? null) : null,
        credits: subject.snapshot.credits ?? null,
        course_level: subject.snapshot.course_level ?? null,
        gpa_boost: subject.snapshot.engine.gpaBoost ?? 0,
        passed: status === "complete" ? result!.passed : null,
        include_in_average: subject.snapshot.include_in_average,
        include_on_certificate: subject.snapshot.include_on_certificate,
        is_descriptive: subject.snapshot.engine.method === "descriptive",
        config_snapshot: subject.snapshot,
        breakdown: result ?? { exempt: true },
      };
    }),
  );
  for (const chunk of chunks(subjectRows, STORE_CHUNK)) {
    await tx`
      INSERT INTO app.student_subject_results (
        school_id, finalization_id, student_id, subject_id, subject_config_id, status, percentage,
        marks_obtained, max_marks, grade_label, gpa_points, passed, include_in_average,
        include_on_certificate, is_descriptive, config_snapshot, breakdown, credits, course_level,
        gpa_boost, weighted_gpa_points
      )
      SELECT ${schoolId}::uuid, ${finalizationId}::uuid, x.student_id, x.subject_id,
             x.subject_config_id, x.status, x.percentage, x.marks_obtained, x.max_marks,
             x.grade_label, x.gpa_points, x.passed, x.include_in_average,
             x.include_on_certificate, x.is_descriptive, x.config_snapshot, x.breakdown,
             x.credits, x.course_level, x.gpa_boost, x.weighted_gpa_points
      FROM jsonb_to_recordset(${tx.json(chunk as never)}::jsonb) AS x(
        student_id uuid, subject_id uuid, subject_config_id uuid, status text, percentage numeric,
        marks_obtained numeric, max_marks numeric, grade_label text, gpa_points numeric,
        passed boolean, include_in_average boolean, include_on_certificate boolean,
        is_descriptive boolean, config_snapshot jsonb, breakdown jsonb, credits numeric,
        course_level text, gpa_boost numeric, weighted_gpa_points numeric
      )
    `;
  }
  const overallRows = students.map((student) => ({
    student_id: student.student.id,
    ...storedResultFormat(student),
    status: student.overall.status,
    average_percentage: student.overall.averagePercentage,
    total_obtained: student.overall.totalObtained,
    total_max: student.overall.totalMax,
    grade_label: student.overall.gradeLabel,
    subjects_failed: student.overall.subjectsFailed,
    academic_status: student.overall.academicStatus,
    weighted_result_value: student.overall.weightedGpa,
    credits_attempted: student.overall.creditsAttempted,
    credits_earned: student.overall.creditsEarned,
    diploma_result: student.overall.diploma ?? null,
  }));
  for (const chunk of chunks(overallRows, STORE_CHUNK * 5)) {
    await tx`
      INSERT INTO app.student_overall_results (
        school_id, finalization_id, student_id, status, average_percentage, total_obtained,
        total_max, grade_label, subjects_failed, academic_status, result_format,
        result_scale_max, result_value, weighted_result_value, credits_attempted, credits_earned,
        diploma_result
      )
      SELECT ${schoolId}::uuid, ${finalizationId}::uuid, x.student_id, x.status,
             x.average_percentage, x.total_obtained, x.total_max, x.grade_label,
             x.subjects_failed, x.academic_status, x.result_format, x.result_scale_max,
             x.result_value, x.weighted_result_value, x.credits_attempted, x.credits_earned,
             x.diploma_result
      FROM jsonb_to_recordset(${tx.json(chunk as never)}::jsonb) AS x(
        student_id uuid, status text, average_percentage numeric, total_obtained numeric,
        total_max numeric, grade_label text, subjects_failed int, academic_status text,
        result_format text, result_scale_max numeric, result_value numeric,
        weighted_result_value numeric, credits_attempted numeric, credits_earned numeric,
        diploma_result jsonb
      )
    `;
  }
}

/**
 * The result format a finalized overall row records: the computed display when the result is
 * complete, otherwise the grade's format (from the subjects' snapshots) with no value yet.
 */
function storedResultFormat(student: StudentComputation): {
  result_format: string | null;
  result_scale_max: number | null;
  result_value: number | null;
} {
  const display = student.overall.display;
  if (display) {
    return {
      result_format: display.format,
      result_scale_max: display.max,
      result_value: display.value,
    };
  }
  const format = student.subjects[0]?.snapshot.program.result_format ?? {
    format: "percentage" as const,
    max: 100,
  };
  return { result_format: format.format, result_scale_max: format.max, result_value: null };
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
  await snapshotReportNotes(tx, schoolId, finalization!);
  await snapshotOutcomeAchievements(tx, schoolId, finalization!);
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
    /** Descriptive subjects: the corrected descriptor of a graded mark. */
    descriptor_id?: string | null;
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
    const descriptorId = mark.status === "graded" ? (mark.descriptor_id ?? null) : null;
    if (snapshot.engine.method === "descriptive") {
      // The snapshot's own scale: a correction is judged by the rules the result was made with.
      const known = (snapshot.engine.descriptors ?? []).some((d) => d.id === descriptorId);
      if (mark.score !== null || (mark.status === "graded" && !known)) {
        throw new CodedHttpException(
          400,
          ERROR_CODES.VALIDATION_FAILED,
          `${assessment.name}: choose one of the grade's descriptors (no score)`,
        );
      }
    } else if ((mark.descriptor_id ?? null) !== null) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `${assessment.name} is marked with numbers, not descriptors`,
      );
    } else if (
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
    const [before] = await tx<
      { status: string; score: string | null; descriptor_id: string | null }[]
    >`
      SELECT status, score, descriptor_id FROM app.student_marks
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
          school_id, academic_year_id, assessment_id, student_id, attempt, status, score,
          descriptor_id, entered_by_user_id
        ) VALUES (
          ${schoolId}::uuid, ${old.academic_year_id}::uuid, ${mark.assessment_id}::uuid,
          ${mark.student_id}::uuid, ${mark.attempt}, ${mark.status}, ${mark.score},
          ${descriptorId}::uuid, ${userId}::uuid
        )
        ON CONFLICT (school_id, assessment_id, student_id, attempt) DO UPDATE SET
          status = EXCLUDED.status, score = EXCLUDED.score, descriptor_id = EXCLUDED.descriptor_id,
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
  // Core grades, like marks, are read as they are now: a correction is how a TOK/EE grade or CAS
  // recorded after finalization reaches the diploma total.
  const diplomaCore = await loadFinalDiplomaCore(
    tx,
    schoolId,
    old.academic_year_id,
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
    return { student, subjects, overall: overallFor(subjects, diplomaCore.get(student.id)) };
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
  await snapshotReportNotes(tx, schoolId, next!);
  await snapshotOutcomeAchievements(tx, schoolId, next!);
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
  /** The subject's Arabic name (000263), read live; null when the school has none. */
  subject_name_ar: string | null;
  status: "complete" | "incomplete" | "exempt";
  percentage: number | null;
  marks_obtained: number | null;
  max_marks: number;
  grade_label: string | null;
  gpa_points: number | null;
  /** GPA points with the subject's boost; null without a boost (and on results before 000253). */
  weighted_gpa_points: number | null;
  /** Credit hours as finalized; null when the subject has none. */
  credits: number | null;
  /** Course level label as finalized (Honors, AP, HL...); null for none. */
  course_level: string | null;
  passed: boolean | null;
  include_in_average: boolean;
  include_on_certificate: boolean;
  requirement: string;
  terms: { term_id: string | null; percentage: number | null }[];
  fail_reasons: StoredFailReason[];
  /** The subject teacher's report card comment, as finalized; null when there is none. */
  comment: string | null;
  is_descriptive: boolean;
  /** Descriptive subjects whose descriptors carry points: the skills' average. */
  average_points: number | null;
  /** Descriptive subjects: every skill and the descriptor it was given. */
  skills: DescriptiveSkill[];
  /** Learning outcome achievement as finalized (000267); empty when the school does not show it. */
  outcomes: OutcomeAchievementView[];
}

export interface DescriptiveSkill {
  assessment_id: string;
  name: string;
  category_name: string;
  term_id: string | null;
  descriptor_label: string | null;
}

/** A fail reason as the API reports it: a descriptor reason carries no percentages. */
function failReasonView(reason: FailReason): StoredFailReason {
  return reason.code === "DESCRIPTOR_NOT_ACHIEVED"
    ? { code: reason.code, required: 0, actual: null, descriptor: reason.descriptor }
    : reason;
}

export type StoredFailReason =
  | Exclude<FailReason, { code: "DESCRIPTOR_NOT_ACHIEVED" }>
  | { code: "DESCRIPTOR_NOT_ACHIEVED"; required: 0; actual: null; descriptor: string };

/** A descriptive result's skills, in term then group order, from its stored breakdown. */
export function descriptiveSkills(breakdown: Partial<SubjectResult>): DescriptiveSkill[] {
  if (breakdown.descriptive !== true) return [];
  const categories = [
    ...(breakdown.terms ?? []).flatMap((term) => term.categories),
    ...(breakdown.annualCategories ?? []),
  ];
  return categories.flatMap((category) =>
    category.assessments.map((assessment) => ({
      assessment_id: assessment.assessmentId,
      name: assessment.name,
      category_name: category.name,
      term_id: category.termId,
      descriptor_label: assessment.descriptorLabel ?? null,
    })),
  );
}

export interface StoredStudentResult {
  student_id: string;
  first_name: string;
  last_name: string;
  /** The student's Arabic names (000263); null when the school keeps none. */
  first_name_ar: string | null;
  middle_name_ar: string | null;
  last_name_ar: string | null;
  admission_number: string;
  status: "complete" | "incomplete";
  average_percentage: number | null;
  total_obtained: number | null;
  total_max: number | null;
  grade_label: string | null;
  /** The final result in the grade's format; null while incomplete. */
  result_display: ResultDisplay | null;
  /** The GPA with boosted subjects' weighted points; null unless a GPA has boosted subjects. */
  weighted_gpa: number | null;
  /** Credits of the counted complete subjects, and of those passed; null without credits. */
  credits_attempted: number | null;
  credits_earned: number | null;
  /** The IB Diploma outcome of a points_total result (000262); null otherwise. */
  diploma: DiplomaResultView | null;
  subjects_failed: number;
  academic_status: "promoted" | "supplementary" | "retained" | "incomplete";
  subjects: StoredSubjectResult[];
  /** Report card notes and attendance as finalized; null for finalizations made before 000209. */
  report: ReportNotes | null;
  /**
   * Class rank (000257), computed on read by {@link attachClassRanks}; null until attached, when
   * the grade does not rank, or when the reader may not see it.
   */
  class_rank: ClassRank | null;
}

const n = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * A finalized row's result display. Rows finalized before result formats existed have no format
 * and were percentages, so they read back as the average out of 100.
 */
function storedDisplay(row: {
  status: "complete" | "incomplete";
  average_percentage: string | null;
  result_format: ResultDisplay["format"] | null;
  result_scale_max: string | null;
  result_value: string | null;
}): ResultDisplay | null {
  if (row.status !== "complete") return null;
  if (row.result_format === null || row.result_scale_max === null) {
    return { format: "percentage", value: n(row.average_percentage), max: 100 };
  }
  return {
    format: row.result_format,
    value: n(row.result_value),
    max: Number(row.result_scale_max),
  };
}

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
      first_name_ar: string | null;
      middle_name_ar: string | null;
      last_name_ar: string | null;
      admission_number: string;
      status: "complete" | "incomplete";
      average_percentage: string | null;
      total_obtained: string | null;
      total_max: string | null;
      grade_label: string | null;
      subjects_failed: number;
      academic_status: StoredStudentResult["academic_status"];
      result_format: ResultDisplay["format"] | null;
      result_scale_max: string | null;
      result_value: string | null;
      weighted_result_value: string | null;
      credits_attempted: string | null;
      credits_earned: string | null;
      diploma_result: unknown;
    }[]
  >`
    SELECT overall.student_id, student.first_name, student.last_name, student.admission_number,
           student.first_name_ar, student.middle_name_ar, student.last_name_ar,
           overall.status, overall.average_percentage, overall.total_obtained, overall.total_max,
           overall.grade_label, overall.subjects_failed, overall.academic_status,
           overall.result_format, overall.result_scale_max, overall.result_value,
           overall.weighted_result_value, overall.credits_attempted, overall.credits_earned,
           overall.diploma_result
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
      weighted_gpa_points: string | null;
      credits: string | null;
      course_level: string | null;
      passed: boolean | null;
      include_in_average: boolean;
      include_on_certificate: boolean;
      config_snapshot: ConfigSnapshot;
      breakdown: Partial<SubjectResult>;
    }[]
  >`
    SELECT result.student_id, result.subject_id, result.status, result.percentage,
           result.marks_obtained, result.max_marks, result.grade_label, result.gpa_points,
           result.weighted_gpa_points, result.credits, result.course_level,
           result.passed, result.include_in_average, result.include_on_certificate,
           result.config_snapshot, result.breakdown
    FROM app.student_subject_results AS result
    WHERE result.school_id = ${schoolId}::uuid AND result.finalization_id = ${finalizationId}::uuid
      ${subjectFilter}
  `;
  const report = await readReportNotes(tx, schoolId, finalizationId, filter.studentId);
  const namesAr = await subjectNamesAr(
    tx,
    subjects.map((subject) => subject.subject_id),
  );
  const outcomeSnapshot = await readOutcomeSnapshot(tx, schoolId, finalizationId, filter.studentId);
  return overall.map((row) => ({
    report: report.notes.get(row.student_id) ?? null,
    class_rank: null,
    student_id: row.student_id,
    first_name: row.first_name,
    last_name: row.last_name,
    first_name_ar: row.first_name_ar,
    middle_name_ar: row.middle_name_ar,
    last_name_ar: row.last_name_ar,
    admission_number: row.admission_number,
    status: row.status,
    average_percentage: n(row.average_percentage),
    total_obtained: n(row.total_obtained),
    total_max: n(row.total_max),
    grade_label: row.grade_label,
    result_display: storedDisplay(row),
    weighted_gpa: n(row.weighted_result_value),
    credits_attempted: n(row.credits_attempted),
    credits_earned: n(row.credits_earned),
    diploma: diplomaView(storedDiploma(row.diploma_result)),
    subjects_failed: row.subjects_failed,
    academic_status: row.academic_status,
    subjects: subjects
      .filter((subject) => subject.student_id === row.student_id)
      .map((subject) => ({
        subject_id: subject.subject_id,
        // Names come from the snapshot: what the subject was called when the result was made.
        subject_code: subject.config_snapshot.subject.code,
        subject_name: subject.config_snapshot.subject.name,
        subject_name_ar: namesAr.get(subject.subject_id) ?? null,
        status: subject.status,
        percentage: n(subject.percentage),
        marks_obtained: n(subject.marks_obtained),
        max_marks: Number(subject.max_marks),
        grade_label: subject.grade_label,
        gpa_points: n(subject.gpa_points),
        weighted_gpa_points: n(subject.weighted_gpa_points),
        credits: n(subject.credits),
        course_level: subject.course_level,
        passed: subject.passed,
        include_in_average: subject.include_in_average,
        include_on_certificate: subject.include_on_certificate,
        requirement: subject.config_snapshot.requirement,
        terms: (subject.breakdown.terms ?? []).map((term) => ({
          term_id: term.termId,
          percentage: term.percentage,
        })),
        fail_reasons: (subject.breakdown.failReasons ?? []).map(failReasonView),
        comment: report.subjectComments.get(`${row.student_id}|${subject.subject_id}`) ?? null,
        is_descriptive: subject.breakdown.descriptive === true,
        average_points: subject.breakdown.descriptor?.averagePoints ?? null,
        skills: descriptiveSkills(subject.breakdown),
        outcomes: outcomeSnapshot.get(`${row.student_id}|${subject.subject_id}`) ?? [],
      }))
      .sort((a, b) => a.subject_name.localeCompare(b.subject_name)),
  }));
}

/**
 * The Arabic names (000263) of the given subjects, through app.subject_names_ar: students and
 * parents may not read the app.subjects row behind a result they can read (000037).
 */
export async function subjectNamesAr(
  tx: TransactionSql,
  subjectIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(subjectIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx<{ subject_id: string; name_ar: string }[]>`
    SELECT subject_id, name_ar FROM app.subject_names_ar(${ids}::uuid[])
  `;
  return new Map(rows.map((row) => [row.subject_id, row.name_ar]));
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

/**
 * A student's (or a linked parent's) view: every current finalized result, newest year first. The
 * class rank is attached for the audience reading it (staff, or the student and their parents).
 */
export async function listStudentResults(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  audience: RankAudience,
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
  await attachClassRanks(
    tx,
    schoolId,
    out.map((row) => ({ finalizationId: row.finalization_id, results: [row.result] })),
    audience,
  );
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
      result_display: student.overall.display,
      weighted_gpa: student.overall.weightedGpa,
      credits_attempted: student.overall.creditsAttempted,
      credits_earned: student.overall.creditsEarned,
      diploma: diplomaView(student.overall.diploma),
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
        credits: subject.snapshot.credits ?? null,
        course_level: subject.snapshot.course_level ?? null,
        passed: subject.result?.passed ?? null,
        missing_assessments: subject.result?.missingAssessments.map((m) => m.name) ?? [],
        is_descriptive: subject.snapshot.engine.method === "descriptive",
      })),
    })),
  };
}
