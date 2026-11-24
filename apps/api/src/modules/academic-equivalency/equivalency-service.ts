import { ERROR_CODES } from "@studafy/constants";
import {
  calculateCumulativeResult,
  estimateTawjihiEquivalency,
  validateEquivalencyParts,
} from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { assertCanReadStudent } from "../external-exams/service";
import { loadStandings, readsAsFamily } from "../graduation-requirements/service";

import type { StudentStanding } from "../graduation-requirements/service";
import type {
  EquivalencyConversion,
  EquivalencyDiplomaInput,
  EquivalencyEstimate,
  EquivalencyExamResultInput,
  EquivalencyGpaBasis,
  EquivalencyIssueCode,
  EquivalencyPartDefinition,
  EquivalencyPartStatus,
  EquivalencyPartType,
  EquivalencySourceSystem,
  EquivalencyStatus,
  EquivalencyStudentInput,
} from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * Tawjihi equivalency (000267): a school's rule sets for ESTIMATING the Tawjihi-equivalent
 * percentage of an IGCSE / A Level, IB or American record, and each student's estimate with its
 * step-by-step breakdown. Every rule is the school's own editable setting; the estimate is one the
 * school confirms, never an official Ministry conversion.
 *
 * School leadership manages the sets (academicConfig:manage) and lists a grade level's estimates;
 * staff with academicConfig:read read the sets. A student's estimates are read by whoever may read
 * the student (app.can_read_student: leadership, the student's teachers, the student, linked
 * parents), and the student and their parents see only the sets shown to them.
 *
 * A student is estimated on read, by @studafy/grading-engine, from their external exam results
 * (000255), the IB Diploma outcome of their latest finalized annual result (000263) and the
 * cumulative GPA of their finalized annual results (the transcript's, as graduation requirements
 * read it). A set applies to a student when it is active and lists the grade level of their latest
 * placement (without one, of their latest finalized year).
 */

// ---------------------------------------------------------------------------
// Views and inputs
// ---------------------------------------------------------------------------

export interface NamedRef {
  id: string;
  code: string;
  name: string;
}

/** A part as stored and as the API reads and writes it (snake_case of the engine's definition). */
export interface EquivalencyPartView {
  type: EquivalencyPartType;
  label: string;
  weight: number;
  required: boolean;
  exam_ids: string[];
  best_count: number | null;
  min_count: number | null;
  required_subject_ids: string[];
  grade_percentages: { grade: string; percentage: number }[];
  conversion: {
    mode: EquivalencyConversion["mode"];
    bands: { min: number; percentage: number }[];
    slope: number | null;
    intercept: number | null;
  } | null;
  require_awarded: boolean;
  gpa_basis: EquivalencyGpaBasis | null;
}

export interface EquivalencyRuleSetView {
  id: string;
  name: string;
  source_system: EquivalencySourceSystem;
  grade_levels: { id: string; name: string }[];
  is_active: boolean;
  visible_to_students_and_parents: boolean;
  parts: EquivalencyPartView[];
  exams: NamedRef[];
  subjects: NamedRef[];
  created_at: string;
  updated_at: string;
}

export interface EquivalencyRuleSetInput {
  name: string;
  source_system: EquivalencySourceSystem;
  grade_level_ids: string[];
  is_active?: boolean | undefined;
  visible_to_students_and_parents?: boolean | undefined;
  parts: EquivalencyPartView[];
}

export interface EquivalencyIssueView {
  code: EquivalencyIssueCode;
  kind: "missing" | "not_eligible" | "note";
  part_index: number | null;
  subject: NamedRef | null;
  exam: NamedRef | null;
  grade: string | null;
  required: number | null;
  actual: number | null;
}

export interface EquivalencyPartResultView {
  index: number;
  type: EquivalencyPartType;
  label: string;
  weight: number;
  required: boolean;
  status: EquivalencyPartStatus;
  percentage: number | null;
  share: number | null;
  source_value: number | null;
  source_max: number | null;
  subjects: {
    subject: NamedRef;
    exam: NamedRef;
    grade: string;
    percentage: number | null;
    counted: boolean;
    required_subject: boolean;
  }[];
}

interface EstimateBody {
  status: EquivalencyStatus;
  percentage: number | null;
  parts: EquivalencyPartResultView[];
  issues: EquivalencyIssueView[];
}

export interface EquivalencyEstimateView extends EstimateBody {
  set: {
    id: string;
    name: string;
    source_system: EquivalencySourceSystem;
    visible_to_students_and_parents: boolean;
  };
}

export interface StudentEquivalencyView {
  student_id: string;
  grade_level: { id: string; name: string } | null;
  current_year_pending: boolean;
  estimates: EquivalencyEstimateView[];
}

export interface EquivalencyStudentListView {
  set_id: string;
  academic_year_id: string;
  grade_level_id: string;
  applies_to_grade_level: boolean;
  students: ({
    student_id: string;
    first_name: string;
    last_name: string;
    admission_number: string;
    section_name: string;
  } & EstimateBody)[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const num = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

function invalid(message: string): never {
  throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, message);
}

function notFound(message: string): never {
  throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, message);
}

function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === code;
}

export function partDefinition(part: EquivalencyPartView): EquivalencyPartDefinition {
  return {
    type: part.type,
    label: part.label.trim(),
    weight: part.weight,
    required: part.required,
    examIds: part.exam_ids,
    bestCount: part.best_count,
    minCount: part.min_count,
    requiredSubjectIds: part.required_subject_ids,
    gradePercentages: part.grade_percentages.map((entry) => ({
      grade: entry.grade.trim(),
      percentage: entry.percentage,
    })),
    conversion: part.conversion,
    requireAwarded: part.require_awarded,
    gpaBasis: part.gpa_basis,
  };
}

/** The part as stored: trimmed, in a fixed key order. */
function storedPart(part: EquivalencyPartView): EquivalencyPartView {
  const definition = partDefinition(part);
  return {
    type: definition.type,
    label: definition.label,
    weight: definition.weight,
    required: definition.required,
    exam_ids: [...definition.examIds],
    best_count: definition.bestCount,
    min_count: definition.minCount,
    required_subject_ids: [...definition.requiredSubjectIds],
    grade_percentages: definition.gradePercentages.map((entry) => ({ ...entry })),
    conversion: part.conversion
      ? {
          mode: part.conversion.mode,
          bands: part.conversion.bands.map((band) => ({
            min: band.min,
            percentage: band.percentage,
          })),
          slope: part.conversion.slope,
          intercept: part.conversion.intercept,
        }
      : null,
    require_awarded: definition.requireAwarded,
    gpa_basis: definition.gpaBasis,
  };
}

/** A stored part read defensively: a field missing from an older row reads as empty. */
function readPart(value: unknown): EquivalencyPartView {
  const part = (value ?? {}) as Partial<EquivalencyPartView>;
  return {
    type: part.type ?? "exam_subjects",
    label: part.label ?? "",
    weight: Number(part.weight ?? 0),
    required: part.required ?? true,
    exam_ids: part.exam_ids ?? [],
    best_count: part.best_count ?? null,
    min_count: part.min_count ?? null,
    required_subject_ids: part.required_subject_ids ?? [],
    grade_percentages: part.grade_percentages ?? [],
    conversion: part.conversion ?? null,
    require_awarded: part.require_awarded ?? false,
    gpa_basis: part.gpa_basis ?? null,
  };
}

// ---------------------------------------------------------------------------
// Sets: reading
// ---------------------------------------------------------------------------

interface LoadedSet {
  view: EquivalencyRuleSetView;
  gradeLevelIds: Set<string>;
}

async function loadSets(
  tx: TransactionSql,
  schoolId: string,
  filter: { setId?: string; activeOnly?: boolean } = {},
): Promise<LoadedSet[]> {
  const setClause = filter.setId ? tx`AND rule_set.id = ${filter.setId}::uuid` : tx``;
  const activeClause = filter.activeOnly ? tx`AND rule_set.is_active` : tx``;
  const sets = await tx<
    {
      id: string;
      name: string;
      source_system: EquivalencySourceSystem;
      parts: unknown[];
      is_active: boolean;
      visible_to_students_and_parents: boolean;
      created_at: Date;
      updated_at: Date;
    }[]
  >`
    SELECT rule_set.id, rule_set.name, rule_set.source_system, rule_set.parts, rule_set.is_active,
           rule_set.visible_to_students_and_parents, rule_set.created_at, rule_set.updated_at
    FROM app.equivalency_rule_sets AS rule_set
    WHERE rule_set.school_id = ${schoolId}::uuid ${setClause} ${activeClause}
    ORDER BY rule_set.name, rule_set.id
  `;
  if (sets.length === 0) return [];
  const setIds = sets.map((row) => row.id);
  const grades = await tx<{ set_id: string; id: string; name: string }[]>`
    SELECT link.set_id, grade.id, grade.name
    FROM app.equivalency_rule_set_grade_levels AS link
    JOIN app.grade_levels AS grade
      ON grade.id = link.grade_level_id AND grade.school_id = link.school_id
    WHERE link.school_id = ${schoolId}::uuid AND link.set_id = ANY (${setIds}::uuid[])
    ORDER BY grade.sort_order, grade.name
  `;
  const parsed = sets.map((row) => ({ row, parts: (row.parts ?? []).map(readPart) }));
  const examIds = [...new Set(parsed.flatMap(({ parts }) => parts.flatMap((p) => p.exam_ids)))];
  // The exam catalogue is configuration (tenant isolation only): readable by every caller.
  const exams =
    examIds.length === 0
      ? []
      : await tx<NamedRef[]>`
          SELECT id, code, name FROM app.external_exams
          WHERE school_id = ${schoolId}::uuid AND id = ANY (${examIds}::uuid[])
        `;
  // Through the 000267 helper: app.subjects' role scope would hide a required subject a student has
  // not taken from the student and their parents.
  const subjects = await tx<{ subject_id: string; code: string; name: string }[]>`
    SELECT subject_id, code, name FROM app.equivalency_rule_subject_names(${setIds}::uuid[])
  `;
  const examById = new Map(exams.map((exam) => [exam.id, exam]));
  const subjectById = new Map(
    subjects.map((subject) => [
      subject.subject_id,
      { id: subject.subject_id, code: subject.code, name: subject.name },
    ]),
  );
  const byName = (a: NamedRef, b: NamedRef) => a.name.localeCompare(b.name);
  return parsed.map(({ row, parts }) => ({
    gradeLevelIds: new Set(grades.filter((g) => g.set_id === row.id).map((g) => g.id)),
    view: {
      id: row.id,
      name: row.name,
      source_system: row.source_system,
      grade_levels: grades
        .filter((grade) => grade.set_id === row.id)
        .map((grade) => ({ id: grade.id, name: grade.name })),
      is_active: row.is_active,
      visible_to_students_and_parents: row.visible_to_students_and_parents,
      parts,
      exams: [...new Set(parts.flatMap((part) => part.exam_ids))]
        .flatMap((id) => (examById.has(id) ? [examById.get(id)!] : []))
        .sort(byName),
      subjects: [...new Set(parts.flatMap((part) => part.required_subject_ids))]
        .flatMap((id) => (subjectById.has(id) ? [subjectById.get(id)!] : []))
        .sort(byName),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    },
  }));
}

export async function listEquivalencyRuleSets(
  tx: TransactionSql,
  schoolId: string,
): Promise<EquivalencyRuleSetView[]> {
  return (await loadSets(tx, schoolId)).map((set) => set.view);
}

async function requireSet(tx: TransactionSql, schoolId: string, setId: string): Promise<LoadedSet> {
  const [set] = await loadSets(tx, schoolId, { setId });
  if (!set) notFound("Equivalency rule set not found");
  return set;
}

// ---------------------------------------------------------------------------
// Sets: writing
// ---------------------------------------------------------------------------

async function assertAllExist(
  tx: TransactionSql,
  schoolId: string,
  table: "grade_levels" | "subjects" | "external_exams",
  ids: readonly string[],
  what: string,
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const [row] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM ${tx("app." + table)}
    WHERE school_id = ${schoolId}::uuid AND id = ANY (${unique}::uuid[])
  `;
  if (row?.count !== unique.length) invalid(`Unknown ${what}`);
}

async function checkSetInput(
  tx: TransactionSql,
  schoolId: string,
  input: EquivalencyRuleSetInput,
): Promise<EquivalencyPartView[]> {
  if (new Set(input.grade_level_ids).size !== input.grade_level_ids.length) {
    invalid("A grade level is listed twice.");
  }
  const parts = input.parts.map(storedPart);
  const issues = validateEquivalencyParts(parts.map(partDefinition));
  if (issues.length > 0) invalid(issues.map((issue) => issue.message).join(" "));
  await assertAllExist(tx, schoolId, "grade_levels", input.grade_level_ids, "grade level");
  await assertAllExist(
    tx,
    schoolId,
    "external_exams",
    parts.flatMap((part) => part.exam_ids),
    "external exam",
  );
  await assertAllExist(
    tx,
    schoolId,
    "subjects",
    parts.flatMap((part) => part.required_subject_ids),
    "subject",
  );
  return parts;
}

function duplicateName(name: string): never {
  throw new CodedHttpException(
    409,
    ERROR_CODES.CONFLICT_DUPLICATE_ENTRY,
    `The school already has an equivalency rule set named "${name}"`,
  );
}

async function writeGradeLevels(
  tx: TransactionSql,
  schoolId: string,
  setId: string,
  gradeLevelIds: readonly string[],
): Promise<void> {
  await tx`
    DELETE FROM app.equivalency_rule_set_grade_levels
    WHERE school_id = ${schoolId}::uuid AND set_id = ${setId}::uuid
  `;
  await tx`
    INSERT INTO app.equivalency_rule_set_grade_levels (school_id, set_id, grade_level_id)
    SELECT ${schoolId}::uuid, ${setId}::uuid, grade_level_id
    FROM unnest(${[...gradeLevelIds]}::uuid[]) AS grade_level_id
  `;
}

/** What the audit log keeps of a set: the same fields before and after. */
const inputSummary = (input: EquivalencyRuleSetInput, parts: EquivalencyPartView[]) => ({
  name: input.name,
  source_system: input.source_system,
  grade_level_ids: input.grade_level_ids,
  is_active: input.is_active ?? true,
  visible_to_students_and_parents: input.visible_to_students_and_parents ?? false,
  parts,
});

const viewSummary = (view: EquivalencyRuleSetView) => ({
  name: view.name,
  source_system: view.source_system,
  grade_level_ids: view.grade_levels.map((grade) => grade.id),
  is_active: view.is_active,
  visible_to_students_and_parents: view.visible_to_students_and_parents,
  parts: view.parts,
});

export async function createEquivalencyRuleSet(
  tx: TransactionSql,
  schoolId: string,
  input: EquivalencyRuleSetInput,
): Promise<EquivalencyRuleSetView> {
  const parts = await checkSetInput(tx, schoolId, input);
  let setId: string;
  try {
    const [row] = await tx.savepoint(
      (sp) => sp<{ id: string }[]>`
        INSERT INTO app.equivalency_rule_sets (
          school_id, name, source_system, parts, is_active, visible_to_students_and_parents
        )
        VALUES (
          ${schoolId}::uuid, ${input.name}, ${input.source_system}, ${sp.json(parts as never)}::jsonb,
          ${input.is_active ?? true}, ${input.visible_to_students_and_parents ?? false}
        )
        RETURNING id
      `,
    );
    setId = row!.id;
  } catch (error) {
    if (isPgError(error, "23505")) duplicateName(input.name);
    throw error;
  }
  await writeGradeLevels(tx, schoolId, setId, input.grade_level_ids);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "equivalency_rule_sets",
    targetId: setId,
    newValues: inputSummary(input, parts),
  });
  return (await requireSet(tx, schoolId, setId)).view;
}

export async function updateEquivalencyRuleSet(
  tx: TransactionSql,
  schoolId: string,
  setId: string,
  input: EquivalencyRuleSetInput,
): Promise<EquivalencyRuleSetView> {
  const before = await requireSet(tx, schoolId, setId);
  const parts = await checkSetInput(tx, schoolId, input);
  try {
    await tx.savepoint(
      (sp) => sp`
        UPDATE app.equivalency_rule_sets
        SET name = ${input.name},
            source_system = ${input.source_system},
            parts = ${sp.json(parts as never)}::jsonb,
            is_active = ${input.is_active ?? true},
            visible_to_students_and_parents = ${input.visible_to_students_and_parents ?? false},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${setId}::uuid AND school_id = ${schoolId}::uuid
      `,
    );
  } catch (error) {
    if (isPgError(error, "23505")) duplicateName(input.name);
    throw error;
  }
  await writeGradeLevels(tx, schoolId, setId, input.grade_level_ids);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "equivalency_rule_sets",
    targetId: setId,
    oldValues: viewSummary(before.view),
    newValues: inputSummary(input, parts),
  });
  return (await requireSet(tx, schoolId, setId)).view;
}

export async function deleteEquivalencyRuleSet(
  tx: TransactionSql,
  schoolId: string,
  setId: string,
): Promise<void> {
  const before = await requireSet(tx, schoolId, setId);
  await tx`
    DELETE FROM app.equivalency_rule_sets
    WHERE id = ${setId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "equivalency_rule_sets",
    targetId: setId,
    oldValues: viewSummary(before.view),
  });
}

// ---------------------------------------------------------------------------
// Students: what an estimate reads
// ---------------------------------------------------------------------------

interface StudentEvidence {
  standing: StudentStanding;
  input: EquivalencyStudentInput;
}

/** A numeric score as a grade label: "7.00" reads "7", like the IB DP and AP presets show it. */
function gradeOf(label: string | null, numeric: string | null): string | null {
  if (label !== null && label.trim() !== "") return label.trim();
  if (numeric === null) return null;
  return String(Number(numeric));
}

async function loadEvidence(
  tx: TransactionSql,
  schoolId: string,
  studentIds: readonly string[],
  yearId: string | null = null,
): Promise<Map<string, StudentEvidence>> {
  const ids = [...studentIds];
  const standings = await loadStandings(tx, schoolId, ids, yearId);
  // Each result's grade: the score of the exam's first component (by order) that has one.
  const exams = await tx<
    {
      student_id: string;
      exam_id: string;
      subject_id: string | null;
      total_score: string | null;
      label_score: string | null;
      numeric_score: string | null;
    }[]
  >`
    SELECT result.student_id, result.exam_id, result.subject_id,
           result.total_score::text AS total_score, first_score.label_score,
           first_score.numeric_score::text AS numeric_score
    FROM app.student_external_exam_results AS result
    LEFT JOIN LATERAL (
      SELECT score.label_score, score.numeric_score
      FROM app.student_external_exam_scores AS score
      JOIN app.external_exam_components AS component
        ON component.id = score.component_id AND component.school_id = score.school_id
      WHERE score.school_id = result.school_id AND score.result_id = result.id
      ORDER BY component.sort_order, component.id
      LIMIT 1
    ) AS first_score ON true
    WHERE result.school_id = ${schoolId}::uuid AND result.student_id = ANY (${ids}::uuid[])
  `;
  // The diploma outcome of the latest finalized annual result that has one (000263).
  const diplomas = await tx<
    {
      student_id: string;
      status: EquivalencyDiplomaInput["status"];
      total: string | null;
      max: string | null;
    }[]
  >`
    SELECT DISTINCT ON (overall.student_id)
           overall.student_id, overall.diploma_result->>'status' AS status,
           overall.diploma_result->>'total' AS total, overall.diploma_result->>'max' AS max
    FROM app.student_overall_results AS overall
    JOIN app.result_finalizations AS finalization
      ON finalization.id = overall.finalization_id AND finalization.school_id = overall.school_id
    JOIN app.academic_years AS year
      ON year.id = finalization.academic_year_id AND year.school_id = finalization.school_id
    WHERE overall.school_id = ${schoolId}::uuid AND overall.student_id = ANY (${ids}::uuid[])
      AND finalization.term_id IS NULL AND finalization.status = 'finalized'
      AND overall.diploma_result IS NOT NULL
    ORDER BY overall.student_id, year.starts_on DESC, finalization.finalized_at DESC, finalization.id
  `;

  const evidence = new Map<string, StudentEvidence>();
  for (const studentId of ids) {
    const standing = standings.get(studentId)!;
    const cumulative = calculateCumulativeResult(standing.years, standing.rounding);
    const diploma = diplomas.find((row) => row.student_id === studentId);
    const examResults: EquivalencyExamResultInput[] = exams
      .filter((row) => row.student_id === studentId)
      .map((row) => ({
        examId: row.exam_id,
        subjectId: row.subject_id,
        grade: gradeOf(row.label_score, row.numeric_score),
        total: num(row.total_score),
      }));
    evidence.set(studentId, {
      standing,
      input: {
        examResults,
        diploma:
          diploma && ["awarded", "not_awarded", "pending"].includes(diploma.status)
            ? { status: diploma.status, total: num(diploma.total), max: num(diploma.max) ?? 45 }
            : null,
        gpa: cumulative.gpa,
        weightedGpa: cumulative.weightedGpa,
        gpaScaleMax: cumulative.gpaScaleMax,
        currentYearPending: standing.currentYearPending,
      },
    });
  }
  return evidence;
}

function applies(set: LoadedSet, standing: StudentStanding): boolean {
  return (
    set.view.is_active &&
    standing.gradeLevel !== null &&
    set.gradeLevelIds.has(standing.gradeLevel.id)
  );
}

type NameLookup = Map<string, NamedRef>;

const unknownRef = (id: string): NamedRef => ({ id, code: "", name: "" });

function estimateView(
  set: LoadedSet,
  student: EquivalencyStudentInput,
  subjects: NameLookup,
): EstimateBody {
  const estimate: EquivalencyEstimate = estimateTawjihiEquivalency(
    set.view.parts.map(partDefinition),
    student,
  );
  const exams = new Map(set.view.exams.map((exam) => [exam.id, exam]));
  const subject = (id: string) => subjects.get(id) ?? unknownRef(id);
  const exam = (id: string) => exams.get(id) ?? unknownRef(id);
  return {
    status: estimate.status,
    percentage: estimate.percentage,
    parts: estimate.parts.map((part) => ({
      index: part.index,
      type: part.type,
      label: part.label,
      weight: part.weight,
      required: part.required,
      status: part.status,
      percentage: part.percentage,
      share: part.share,
      source_value: part.sourceValue,
      source_max: part.sourceMax,
      subjects: part.subjects.map((step) => ({
        subject: subject(step.subjectId),
        exam: exam(step.examId),
        grade: step.grade,
        percentage: step.percentage,
        counted: step.counted,
        required_subject: step.requiredSubject,
      })),
    })),
    issues: estimate.issues.map((found) => ({
      code: found.code,
      kind: found.kind,
      part_index: found.partIndex,
      subject: found.subjectId === null ? null : subject(found.subjectId),
      exam: found.examId === null ? null : exam(found.examId),
      grade: found.grade,
      required: found.required,
      actual: found.actual,
    })),
  };
}

/** Subject names for a breakdown: the required ones (from the sets) and the student's results'. */
function lookup(sets: readonly LoadedSet[], extra: readonly NamedRef[]): NameLookup {
  const names: NameLookup = new Map();
  for (const ref of [...sets.flatMap((set) => set.view.subjects), ...extra]) names.set(ref.id, ref);
  return names;
}

async function requireStudent(tx: TransactionSql, schoolId: string, studentId: string) {
  const [student] = await tx<{ id: string }[]>`
    SELECT id FROM app.students WHERE id = ${studentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!student) notFound("Student not found");
}

// ---------------------------------------------------------------------------
// Students: estimates and the grade-level list
// ---------------------------------------------------------------------------

/** The student's estimate under every active set for their grade level. */
export async function studentEquivalency(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<StudentEquivalencyView> {
  await assertCanReadStudent(tx, studentId);
  // Leadership of another school passes the role check; the student is not in their school.
  await requireStudent(tx, schoolId, studentId);
  const familyOnly = await readsAsFamily(tx, studentId);
  const allSets = await loadSets(tx, schoolId, { activeOnly: true });
  const { standing, input } = (await loadEvidence(tx, schoolId, [studentId])).get(studentId)!;
  const sets = allSets.filter(
    (set) => applies(set, standing) && (!familyOnly || set.view.visible_to_students_and_parents),
  );
  // The 000255 helper names the subjects of the student's results for every caller who may read
  // the student, without widening app.subjects.
  const resultSubjects =
    sets.length === 0
      ? []
      : await tx<{ subject_id: string; code: string; name: string }[]>`
          SELECT subject_id, code, name FROM app.external_exam_result_subjects(${studentId}::uuid)
        `;
  const names = lookup(
    sets,
    resultSubjects.map((row) => ({ id: row.subject_id, code: row.code, name: row.name })),
  );
  return {
    student_id: studentId,
    grade_level: standing.gradeLevel,
    current_year_pending: standing.currentYearPending,
    estimates: sets.map((set) => ({
      set: {
        id: set.view.id,
        name: set.view.name,
        source_system: set.view.source_system,
        visible_to_students_and_parents: set.view.visible_to_students_and_parents,
      },
      ...estimateView(set, input, names),
    })),
  };
}

/** Every student placed in the grade level in the year, estimated under one set (leadership). */
export async function equivalencyStudentList(
  tx: TransactionSql,
  schoolId: string,
  setId: string,
  academicYearId: string,
  gradeLevelId: string,
): Promise<EquivalencyStudentListView> {
  const set = await requireSet(tx, schoolId, setId);
  const [year] = await tx<{ id: string }[]>`
    SELECT id FROM app.academic_years
    WHERE id = ${academicYearId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!year) notFound("Academic year not found");
  const [grade] = await tx<{ id: string }[]>`
    SELECT id FROM app.grade_levels
    WHERE id = ${gradeLevelId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!grade) notFound("Grade level not found");

  const students = await tx<
    {
      student_id: string;
      first_name: string;
      last_name: string;
      admission_number: string;
      section_name: string;
    }[]
  >`
    SELECT student.id AS student_id, student.first_name, student.last_name,
           student.admission_number, section.name AS section_name
    FROM app.student_sections AS placement
    JOIN app.sections AS section
      ON section.id = placement.section_id AND section.school_id = placement.school_id
    JOIN app.students AS student
      ON student.id = placement.student_id AND student.school_id = placement.school_id
    WHERE placement.school_id = ${schoolId}::uuid
      AND placement.academic_year_id = ${academicYearId}::uuid
      AND section.grade_level_id = ${gradeLevelId}::uuid
    ORDER BY student.last_name, student.first_name, student.id
  `;
  const evidence =
    students.length === 0
      ? new Map<string, StudentEvidence>()
      : await loadEvidence(
          tx,
          schoolId,
          students.map((student) => student.student_id),
          academicYearId,
        );
  // Leadership reads every subject of the school.
  const subjectIds = [
    ...new Set(
      [...evidence.values()].flatMap(({ input }) =>
        input.examResults.flatMap((result) => (result.subjectId ? [result.subjectId] : [])),
      ),
    ),
  ];
  const subjects =
    subjectIds.length === 0
      ? []
      : await tx<NamedRef[]>`
          SELECT id, code, name FROM app.subjects
          WHERE school_id = ${schoolId}::uuid AND id = ANY (${subjectIds}::uuid[])
        `;
  const names = lookup([set], subjects);
  return {
    set_id: setId,
    academic_year_id: academicYearId,
    grade_level_id: gradeLevelId,
    applies_to_grade_level: set.gradeLevelIds.has(gradeLevelId),
    students: students.map((student) => ({
      ...student,
      ...estimateView(set, evidence.get(student.student_id)!.input, names),
    })),
  };
}
