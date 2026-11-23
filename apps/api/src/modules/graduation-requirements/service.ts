import { ERROR_CODES } from "@studafy/constants";
import { evaluateGraduationRequirements, validateGraduationRule } from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { assertCanReadStudent } from "../external-exams/service";

import type {
  GraduationExamResultInput,
  GraduationRuleDefinition,
  GraduationRuleType,
  GraduationStatus,
  GraduationYearInput,
  RoundingRule,
} from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * Graduation requirements (000258): a school's requirement sets and their rules, and whether a
 * student meets them.
 *
 * School leadership manages the sets (academicConfig:manage) and reads the "not on track" report;
 * staff with academicConfig:read read them. A student's checklist is read by whoever may read the
 * student (app.can_read_student: leadership, the student's teachers, the student, linked parents),
 * and the student and their parents see only the sets shown to them.
 *
 * A student is checked on read, by @studafy/grading-engine, against the rows an academic transcript
 * reads -- each academic year's current, finalized annual result -- and their external exam results
 * (000255). A set applies to a student when it is active, lists the grade level of the student's
 * latest placement and, when it applies from an academic year, that placement is in that year or a
 * later one. Rules not met yet are pending while that placement's year has no finalized annual
 * result and is still planned or active.
 */

// ---------------------------------------------------------------------------
// Views and inputs
// ---------------------------------------------------------------------------

export interface NamedRef {
  id: string;
  code: string;
  name: string;
}

export interface GraduationRuleView {
  id: string;
  type: GraduationRuleType;
  min_value: number | null;
  group_name: string | null;
  subjects: NamedRef[];
  external_exam: NamedRef | null;
}

export interface GraduationSetView {
  id: string;
  name: string;
  grade_levels: { id: string; name: string }[];
  applies_from_academic_year: { id: string; name: string } | null;
  is_active: boolean;
  visible_to_students_and_parents: boolean;
  rules: GraduationRuleView[];
  created_at: string;
  updated_at: string;
}

export interface GraduationRuleInput {
  type: GraduationRuleType;
  min_value?: number | null | undefined;
  group_name?: string | null | undefined;
  subject_ids?: string[] | undefined;
  external_exam_id?: string | null | undefined;
}

export interface GraduationSetInput {
  name: string;
  grade_level_ids: string[];
  applies_from_academic_year_id?: string | null | undefined;
  is_active?: boolean | undefined;
  visible_to_students_and_parents?: boolean | undefined;
  rules: GraduationRuleInput[];
}

export interface GraduationRuleEvaluationView extends GraduationRuleView {
  status: GraduationStatus;
  current: number | null;
  required: number | null;
  missing_subjects: NamedRef[];
}

export interface GraduationSetEvaluationView {
  set: { id: string; name: string; visible_to_students_and_parents: boolean };
  status: GraduationStatus;
  rules_met: number;
  rules_total: number;
  rules: GraduationRuleEvaluationView[];
}

export interface GraduationChecklistView {
  student_id: string;
  grade_level: { id: string; name: string } | null;
  current_year_pending: boolean;
  years_counted: number;
  sets: GraduationSetEvaluationView[];
}

export interface GraduationPreviewView extends GraduationSetEvaluationView {
  student_id: string;
  current_year_pending: boolean;
  years_counted: number;
  applies: boolean;
}

export interface GraduationReportView {
  academic_year_id: string;
  grade_level_id: string;
  students_checked: number;
  students: {
    student_id: string;
    first_name: string;
    last_name: string;
    admission_number: string;
    section_name: string;
    status: GraduationStatus;
    sets: GraduationSetEvaluationView[];
  }[];
}

/** The outcome a transcript keeps, as it stood at issue. */
export interface TranscriptGraduationRequirement {
  name: string;
  status: GraduationStatus;
  rules_met: number;
  rules_total: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const num = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

const DEFAULT_ROUNDING: RoundingRule = { decimals: 2, mode: "half_up" };

function invalid(message: string): never {
  throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, message);
}

function notFound(message: string): never {
  throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, message);
}

function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === code;
}

// ---------------------------------------------------------------------------
// Sets: reading
// ---------------------------------------------------------------------------

interface SetRow {
  id: string;
  name: string;
  applies_from_academic_year_id: string | null;
  from_year_name: string | null;
  from_year_starts_on: Date | null;
  is_active: boolean;
  visible_to_students_and_parents: boolean;
  created_at: Date;
  updated_at: Date;
}

/** A set as loaded, with what evaluating it needs beside its view. */
interface LoadedSet {
  view: GraduationSetView;
  gradeLevelIds: Set<string>;
  fromYearStartsOn: Date | null;
}

async function loadSets(
  tx: TransactionSql,
  schoolId: string,
  filter: { setId?: string; activeOnly?: boolean } = {},
): Promise<LoadedSet[]> {
  const setClause = filter.setId ? tx`AND requirement_set.id = ${filter.setId}::uuid` : tx``;
  const activeClause = filter.activeOnly ? tx`AND requirement_set.is_active` : tx``;
  const sets = await tx<SetRow[]>`
    SELECT requirement_set.id, requirement_set.name, requirement_set.applies_from_academic_year_id,
           year.name AS from_year_name, year.starts_on AS from_year_starts_on,
           requirement_set.is_active, requirement_set.visible_to_students_and_parents,
           requirement_set.created_at, requirement_set.updated_at
    FROM app.graduation_requirement_sets AS requirement_set
    LEFT JOIN app.academic_years AS year
      ON year.id = requirement_set.applies_from_academic_year_id
     AND year.school_id = requirement_set.school_id
    WHERE requirement_set.school_id = ${schoolId}::uuid ${setClause} ${activeClause}
    ORDER BY requirement_set.name, requirement_set.id
  `;
  if (sets.length === 0) return [];
  const setIds = sets.map((row) => row.id);
  const grades = await tx<{ set_id: string; id: string; name: string }[]>`
    SELECT link.set_id, grade.id, grade.name
    FROM app.graduation_requirement_set_grade_levels AS link
    JOIN app.grade_levels AS grade
      ON grade.id = link.grade_level_id AND grade.school_id = link.school_id
    WHERE link.school_id = ${schoolId}::uuid AND link.set_id = ANY (${setIds}::uuid[])
    ORDER BY grade.sort_order, grade.name
  `;
  const rules = await tx<
    {
      id: string;
      set_id: string;
      rule_type: GraduationRuleType;
      min_value: string | null;
      group_name: string | null;
      external_exam_id: string | null;
      exam_code: string | null;
      exam_name: string | null;
    }[]
  >`
    SELECT requirement.id, requirement.set_id, requirement.rule_type,
           requirement.min_value::text AS min_value, requirement.group_name,
           requirement.external_exam_id, exam.code AS exam_code, exam.name AS exam_name
    FROM app.graduation_requirements AS requirement
    LEFT JOIN app.external_exams AS exam
      ON exam.id = requirement.external_exam_id AND exam.school_id = requirement.school_id
    WHERE requirement.school_id = ${schoolId}::uuid AND requirement.set_id = ANY (${setIds}::uuid[])
    ORDER BY requirement.sort_order, requirement.created_at, requirement.id
  `;
  // Through the 000258 helper: app.subjects' role scope would hide a required subject a student
  // has not taken from the student and their parents.
  const subjects = await tx<
    { requirement_id: string; subject_id: string; code: string; name: string }[]
  >`
    SELECT requirement_id, subject_id, code, name
    FROM app.graduation_requirement_subject_names(${setIds}::uuid[])
    ORDER BY name, code
  `;
  return sets.map((row) => ({
    gradeLevelIds: new Set(grades.filter((g) => g.set_id === row.id).map((g) => g.id)),
    fromYearStartsOn: row.from_year_starts_on,
    view: {
      id: row.id,
      name: row.name,
      grade_levels: grades
        .filter((grade) => grade.set_id === row.id)
        .map((grade) => ({ id: grade.id, name: grade.name })),
      applies_from_academic_year:
        row.applies_from_academic_year_id === null
          ? null
          : { id: row.applies_from_academic_year_id, name: row.from_year_name ?? "" },
      is_active: row.is_active,
      visible_to_students_and_parents: row.visible_to_students_and_parents,
      rules: rules
        .filter((rule) => rule.set_id === row.id)
        .map((rule) => ({
          id: rule.id,
          type: rule.rule_type,
          min_value: num(rule.min_value),
          group_name: rule.group_name,
          subjects: subjects
            .filter((subject) => subject.requirement_id === rule.id)
            .map((subject) => ({ id: subject.subject_id, code: subject.code, name: subject.name })),
          external_exam:
            rule.external_exam_id === null
              ? null
              : { id: rule.external_exam_id, code: rule.exam_code!, name: rule.exam_name! },
        })),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    },
  }));
}

export async function listGraduationSets(
  tx: TransactionSql,
  schoolId: string,
): Promise<GraduationSetView[]> {
  return (await loadSets(tx, schoolId)).map((set) => set.view);
}

async function requireSet(tx: TransactionSql, schoolId: string, setId: string): Promise<LoadedSet> {
  const [set] = await loadSets(tx, schoolId, { setId });
  if (!set) notFound("Graduation requirement set not found");
  return set;
}

// ---------------------------------------------------------------------------
// Sets: writing
// ---------------------------------------------------------------------------

function ruleDefinition(input: GraduationRuleInput): Omit<GraduationRuleDefinition, "id"> {
  const groupName = input.group_name?.trim();
  return {
    type: input.type,
    minValue: input.min_value ?? null,
    groupName: groupName === undefined || groupName === "" ? null : groupName,
    subjectIds: input.subject_ids ?? [],
    externalExamId: input.external_exam_id ?? null,
  };
}

/** Every id belongs to the school's table, or the request is invalid. */
async function assertAllExist(
  tx: TransactionSql,
  schoolId: string,
  table: "grade_levels" | "subjects" | "external_exams" | "academic_years",
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
  input: GraduationSetInput,
): Promise<Omit<GraduationRuleDefinition, "id">[]> {
  if (new Set(input.grade_level_ids).size !== input.grade_level_ids.length) {
    invalid("A grade level is listed twice.");
  }
  const definitions = input.rules.map(ruleDefinition);
  for (const [index, definition] of definitions.entries()) {
    const issues = validateGraduationRule(definition);
    if (issues.length > 0) {
      invalid(`Rule ${index + 1}: ${issues.map((issue) => issue.message).join(" ")}`);
    }
  }
  await assertAllExist(tx, schoolId, "grade_levels", input.grade_level_ids, "grade level");
  if (input.applies_from_academic_year_id) {
    await assertAllExist(
      tx,
      schoolId,
      "academic_years",
      [input.applies_from_academic_year_id],
      "academic year",
    );
  }
  await assertAllExist(
    tx,
    schoolId,
    "subjects",
    definitions.flatMap((definition) => definition.subjectIds),
    "subject",
  );
  await assertAllExist(
    tx,
    schoolId,
    "external_exams",
    definitions.flatMap((definition) =>
      definition.externalExamId === null ? [] : [definition.externalExamId],
    ),
    "external exam",
  );
  return definitions;
}

function duplicateName(name: string): never {
  throw new CodedHttpException(
    409,
    ERROR_CODES.CONFLICT_DUPLICATE_ENTRY,
    `The school already has a graduation requirement set named "${name}"`,
  );
}

/** Replace the set's grade levels and rules (and their subjects) with the input's. */
async function writeContents(
  tx: TransactionSql,
  schoolId: string,
  setId: string,
  input: GraduationSetInput,
  definitions: readonly Omit<GraduationRuleDefinition, "id">[],
): Promise<void> {
  await tx`
    DELETE FROM app.graduation_requirement_set_grade_levels
    WHERE school_id = ${schoolId}::uuid AND set_id = ${setId}::uuid
  `;
  await tx`
    INSERT INTO app.graduation_requirement_set_grade_levels (school_id, set_id, grade_level_id)
    SELECT ${schoolId}::uuid, ${setId}::uuid, grade_level_id
    FROM unnest(${input.grade_level_ids}::uuid[]) AS grade_level_id
  `;
  // Rules are replaced whole; their subject lists go with them (ON DELETE CASCADE).
  await tx`
    DELETE FROM app.graduation_requirements
    WHERE school_id = ${schoolId}::uuid AND set_id = ${setId}::uuid
  `;
  for (const [index, definition] of definitions.entries()) {
    const [rule] = await tx<{ id: string }[]>`
      INSERT INTO app.graduation_requirements (
        school_id, set_id, rule_type, min_value, group_name, external_exam_id, sort_order
      )
      VALUES (
        ${schoolId}::uuid, ${setId}::uuid, ${definition.type}, ${definition.minValue},
        ${definition.groupName}, ${definition.externalExamId}, ${index}
      )
      RETURNING id
    `;
    if (definition.subjectIds.length > 0) {
      await tx`
        INSERT INTO app.graduation_requirement_subjects (school_id, requirement_id, subject_id)
        SELECT ${schoolId}::uuid, ${rule!.id}::uuid, subject_id
        FROM unnest(${[...definition.subjectIds]}::uuid[]) AS subject_id
      `;
    }
  }
}

function auditSummary(input: GraduationSetInput) {
  return {
    name: input.name,
    grade_level_ids: input.grade_level_ids,
    applies_from_academic_year_id: input.applies_from_academic_year_id ?? null,
    is_active: input.is_active ?? true,
    visible_to_students_and_parents: input.visible_to_students_and_parents ?? false,
    rules: input.rules.map((rule) => ({
      type: rule.type,
      min_value: rule.min_value ?? null,
      group_name: rule.group_name ?? null,
      subject_ids: rule.subject_ids ?? [],
      external_exam_id: rule.external_exam_id ?? null,
    })),
  };
}

function setSummary(view: GraduationSetView) {
  return {
    name: view.name,
    grade_level_ids: view.grade_levels.map((grade) => grade.id),
    applies_from_academic_year_id: view.applies_from_academic_year?.id ?? null,
    is_active: view.is_active,
    visible_to_students_and_parents: view.visible_to_students_and_parents,
    rules: view.rules.map((rule) => ({
      type: rule.type,
      min_value: rule.min_value,
      group_name: rule.group_name,
      subject_ids: rule.subjects.map((subject) => subject.id),
      external_exam_id: rule.external_exam?.id ?? null,
    })),
  };
}

export async function createGraduationSet(
  tx: TransactionSql,
  schoolId: string,
  input: GraduationSetInput,
): Promise<GraduationSetView> {
  const definitions = await checkSetInput(tx, schoolId, input);
  let setId: string;
  try {
    const [row] = await tx.savepoint(
      (sp) => sp<{ id: string }[]>`
        INSERT INTO app.graduation_requirement_sets (
          school_id, name, applies_from_academic_year_id, is_active, visible_to_students_and_parents
        )
        VALUES (
          ${schoolId}::uuid, ${input.name}, ${input.applies_from_academic_year_id ?? null},
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
  await writeContents(tx, schoolId, setId, input, definitions);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "graduation_requirement_sets",
    targetId: setId,
    newValues: auditSummary(input),
  });
  return (await requireSet(tx, schoolId, setId)).view;
}

export async function updateGraduationSet(
  tx: TransactionSql,
  schoolId: string,
  setId: string,
  input: GraduationSetInput,
): Promise<GraduationSetView> {
  const before = await requireSet(tx, schoolId, setId);
  const definitions = await checkSetInput(tx, schoolId, input);
  try {
    await tx.savepoint(
      (sp) => sp`
        UPDATE app.graduation_requirement_sets
        SET name = ${input.name},
            applies_from_academic_year_id = ${input.applies_from_academic_year_id ?? null},
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
  await writeContents(tx, schoolId, setId, input, definitions);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "graduation_requirement_sets",
    targetId: setId,
    oldValues: setSummary(before.view),
    newValues: auditSummary(input),
  });
  return (await requireSet(tx, schoolId, setId)).view;
}

/** Transcripts already issued keep the outcome they were issued with. */
export async function deleteGraduationSet(
  tx: TransactionSql,
  schoolId: string,
  setId: string,
): Promise<void> {
  const before = await requireSet(tx, schoolId, setId);
  await tx`
    DELETE FROM app.graduation_requirement_sets
    WHERE id = ${setId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "graduation_requirement_sets",
    targetId: setId,
    oldValues: setSummary(before.view),
  });
}

// ---------------------------------------------------------------------------
// Students: what a check reads
// ---------------------------------------------------------------------------

interface StudentStanding {
  gradeLevel: { id: string; name: string } | null;
  /** The start of the year the student's grade level is from: when a set applies from a year. */
  referenceStartsOn: Date | null;
  currentYearPending: boolean;
  years: GraduationYearInput[];
  rounding: RoundingRule;
  examResults: GraduationExamResultInput[];
}

interface PlacementRow {
  student_id: string;
  grade_level_id: string;
  grade_level_name: string;
  starts_on: Date;
  pending: boolean;
}

/**
 * Each student's placement: the latest one, or the one in `yearId` when given. `pending` when that
 * year is still planned or active and has no finalized annual result for the student.
 */
async function loadPlacements(
  tx: TransactionSql,
  schoolId: string,
  studentIds: readonly string[],
  yearId: string | null,
): Promise<Map<string, PlacementRow>> {
  const yearClause = yearId ? tx`AND placement.academic_year_id = ${yearId}::uuid` : tx``;
  const rows = await tx<PlacementRow[]>`
    SELECT DISTINCT ON (placement.student_id)
           placement.student_id, grade.id AS grade_level_id, grade.name AS grade_level_name,
           year.starts_on,
           year.status IN ('planned', 'active') AND NOT EXISTS (
             SELECT 1
             FROM app.student_overall_results AS overall
             JOIN app.result_finalizations AS finalization
               ON finalization.id = overall.finalization_id
              AND finalization.school_id = overall.school_id
             WHERE overall.school_id = placement.school_id
               AND overall.student_id = placement.student_id
               AND finalization.academic_year_id = placement.academic_year_id
               AND finalization.term_id IS NULL AND finalization.status = 'finalized'
           ) AS pending
    FROM app.student_sections AS placement
    JOIN app.sections AS section
      ON section.id = placement.section_id AND section.school_id = placement.school_id
    JOIN app.grade_levels AS grade
      ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    JOIN app.academic_years AS year
      ON year.id = placement.academic_year_id AND year.school_id = placement.school_id
    WHERE placement.school_id = ${schoolId}::uuid
      AND placement.student_id = ANY (${[...studentIds]}::uuid[]) ${yearClause}
    ORDER BY placement.student_id, year.starts_on DESC
  `;
  return new Map(rows.map((row) => [row.student_id, row]));
}

/**
 * Each student's years exactly as a transcript reads them: the current annual finalization of every
 * academic year (two in one year, a change of section, keep the later), oldest year first, with the
 * subjects' coefficients and rounding from the snapshots their results were computed with.
 */
async function loadStandings(
  tx: TransactionSql,
  schoolId: string,
  studentIds: readonly string[],
  yearId: string | null = null,
): Promise<Map<string, StudentStanding>> {
  const ids = [...studentIds];
  const placements = await loadPlacements(tx, schoolId, ids, yearId);
  const finalizations = await tx<
    {
      student_id: string;
      finalization_id: string;
      year_name: string;
      starts_on: Date;
      grade_level_id: string;
      grade_level_name: string;
      status: "complete" | "incomplete";
      result_format: string | null;
      result_scale_max: string | null;
    }[]
  >`
    SELECT DISTINCT ON (overall.student_id, finalization.academic_year_id)
           overall.student_id, finalization.id AS finalization_id, year.name AS year_name,
           year.starts_on, grade.id AS grade_level_id, grade.name AS grade_level_name,
           overall.status, overall.result_format, overall.result_scale_max::text AS result_scale_max
    FROM app.student_overall_results AS overall
    JOIN app.result_finalizations AS finalization
      ON finalization.id = overall.finalization_id AND finalization.school_id = overall.school_id
    JOIN app.academic_years AS year
      ON year.id = finalization.academic_year_id AND year.school_id = finalization.school_id
    JOIN app.sections AS section
      ON section.id = finalization.section_id AND section.school_id = finalization.school_id
    JOIN app.grade_levels AS grade
      ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    WHERE overall.school_id = ${schoolId}::uuid AND overall.student_id = ANY (${ids}::uuid[])
      AND finalization.term_id IS NULL AND finalization.status = 'finalized'
    ORDER BY overall.student_id, finalization.academic_year_id, finalization.finalized_at DESC,
             finalization.id
  `;
  const subjects =
    finalizations.length === 0
      ? []
      : await tx<
          {
            student_id: string;
            finalization_id: string;
            subject_id: string;
            subject_name: string | null;
            status: "complete" | "incomplete" | "exempt";
            percentage: string | null;
            gpa_points: string | null;
            weighted_gpa_points: string | null;
            credits: string | null;
            passed: boolean | null;
            include_in_average: boolean;
            average_weight: string | null;
            rounding: RoundingRule | null;
            descriptive: boolean | null;
          }[]
        >`
          SELECT result.student_id, result.finalization_id, result.subject_id,
                 result.config_snapshot->'subject'->>'name' AS subject_name, result.status,
                 result.percentage::text AS percentage, result.gpa_points::text AS gpa_points,
                 result.weighted_gpa_points::text AS weighted_gpa_points,
                 result.credits::text AS credits, result.passed, result.include_in_average,
                 result.config_snapshot->>'average_weight' AS average_weight,
                 result.config_snapshot->'program'->'rounding' AS rounding,
                 (result.is_descriptive
                  OR coalesce((result.breakdown->>'descriptive')::boolean, false)) AS descriptive
          FROM app.student_subject_results AS result
          WHERE result.school_id = ${schoolId}::uuid AND result.student_id = ANY (${ids}::uuid[])
            AND result.finalization_id = ANY (${finalizations.map((f) => f.finalization_id)}::uuid[])
        `;
  const exams = await tx<{ student_id: string; exam_id: string; total_score: string | null }[]>`
    SELECT student_id, exam_id, total_score::text AS total_score
    FROM app.student_external_exam_results
    WHERE school_id = ${schoolId}::uuid AND student_id = ANY (${ids}::uuid[])
  `;

  const standings = new Map<string, StudentStanding>();
  for (const studentId of ids) {
    const own = finalizations
      .filter((row) => row.student_id === studentId)
      .sort((a, b) => a.starts_on.getTime() - b.starts_on.getTime());
    let rounding = DEFAULT_ROUNDING;
    const years: GraduationYearInput[] = own.map((finalization) => {
      const rows = subjects.filter(
        (row) =>
          row.student_id === studentId && row.finalization_id === finalization.finalization_id,
      );
      // The latest year's rounding rule, as a transcript's cumulative figures use.
      rounding = rows.find((row) => row.rounding !== null)?.rounding ?? DEFAULT_ROUNDING;
      return {
        label: finalization.year_name,
        gpaScaleMax:
          finalization.status === "complete" && finalization.result_format === "gpa"
            ? num(finalization.result_scale_max)
            : null,
        subjects: rows.map((row) => {
          const weight = Number(row.average_weight);
          return {
            subjectId: row.subject_id,
            label: `${row.subject_name ?? ""} (${finalization.year_name})`,
            status: row.status,
            includeInAverage: row.include_in_average,
            averageWeight: Number.isFinite(weight) && weight > 0 ? weight : 1,
            percentage: num(row.percentage),
            gpaPoints: num(row.gpa_points),
            weightedGpaPoints: num(row.weighted_gpa_points),
            credits: num(row.credits),
            passed: row.passed,
            descriptive: row.descriptive === true,
          };
        }),
      };
    });
    const placement = placements.get(studentId);
    const latest = own.at(-1);
    standings.set(studentId, {
      gradeLevel: placement
        ? { id: placement.grade_level_id, name: placement.grade_level_name }
        : latest
          ? { id: latest.grade_level_id, name: latest.grade_level_name }
          : null,
      referenceStartsOn: placement?.starts_on ?? latest?.starts_on ?? null,
      currentYearPending: placement?.pending ?? false,
      years,
      rounding,
      examResults: exams
        .filter((row) => row.student_id === studentId)
        .map((row) => ({ examId: row.exam_id, totalScore: num(row.total_score) })),
    });
  }
  return standings;
}

function applies(set: LoadedSet, standing: StudentStanding): boolean {
  if (!set.view.is_active || !standing.gradeLevel) return false;
  if (!set.gradeLevelIds.has(standing.gradeLevel.id)) return false;
  if (set.fromYearStartsOn === null) return true;
  return (
    standing.referenceStartsOn !== null &&
    standing.referenceStartsOn.getTime() >= set.fromYearStartsOn.getTime()
  );
}

function evaluateSet(set: LoadedSet, standing: StudentStanding): GraduationSetEvaluationView {
  const evaluation = evaluateGraduationRequirements({
    rules: set.view.rules.map((rule) => ({
      id: rule.id,
      type: rule.type,
      minValue: rule.min_value,
      groupName: rule.group_name,
      subjectIds: rule.subjects.map((subject) => subject.id),
      externalExamId: rule.external_exam?.id ?? null,
    })),
    years: standing.years,
    examResults: standing.examResults,
    currentYearPending: standing.currentYearPending,
    rounding: standing.rounding,
  });
  return {
    set: {
      id: set.view.id,
      name: set.view.name,
      visible_to_students_and_parents: set.view.visible_to_students_and_parents,
    },
    status: evaluation.status,
    rules_met: evaluation.rulesMet,
    rules_total: evaluation.rulesTotal,
    rules: set.view.rules.map((rule, index) => {
      const result = evaluation.rules[index]!;
      const missing = new Set(result.missingSubjectIds);
      return {
        ...rule,
        status: result.status,
        current: result.current,
        required: result.required,
        missing_subjects: rule.subjects.filter((subject) => missing.has(subject.id)),
      };
    }),
  };
}

async function requireStudent(tx: TransactionSql, schoolId: string, studentId: string) {
  const [student] = await tx<{ id: string }[]>`
    SELECT id FROM app.students WHERE id = ${studentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!student) notFound("Student not found");
}

/**
 * Whether the caller sees the student only as the student or a linked parent: they then see only
 * the sets shown to students and parents. Staff (leadership, the student's teachers) see them all.
 */
async function readsAsFamily(tx: TransactionSql, studentId: string): Promise<boolean> {
  const [row] = await tx<{ related: boolean; privileged: boolean; teacher: boolean }[]>`
    SELECT app.is_related_to_student(${studentId}::uuid) AS related,
           app.is_privileged_over_student(${studentId}::uuid) AS privileged,
           app.current_user_teacher_id() IS NOT NULL AS teacher
  `;
  return row?.related === true && !row.privileged && !row.teacher;
}

// ---------------------------------------------------------------------------
// Students: checklist, preview, report and transcript
// ---------------------------------------------------------------------------

/** The student's checklist for every active set that applies to them. */
export async function studentGraduationChecklist(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<GraduationChecklistView> {
  await assertCanReadStudent(tx, studentId);
  // Leadership of another school passes the role check; the student is not in their school.
  await requireStudent(tx, schoolId, studentId);
  const familyOnly = await readsAsFamily(tx, studentId);
  const standing = (await loadStandings(tx, schoolId, [studentId])).get(studentId)!;
  const sets = (await loadSets(tx, schoolId, { activeOnly: true })).filter(
    (set) => applies(set, standing) && (!familyOnly || set.view.visible_to_students_and_parents),
  );
  return {
    student_id: studentId,
    grade_level: standing.gradeLevel,
    current_year_pending: standing.currentYearPending,
    years_counted: standing.years.length,
    sets: sets.map((set) => evaluateSet(set, standing)),
  };
}

/** Check a student against one set, whether it applies to them or not (setting up a set). */
export async function previewGraduationSet(
  tx: TransactionSql,
  schoolId: string,
  setId: string,
  studentId: string,
): Promise<GraduationPreviewView> {
  const set = await requireSet(tx, schoolId, setId);
  await requireStudent(tx, schoolId, studentId);
  const standing = (await loadStandings(tx, schoolId, [studentId])).get(studentId)!;
  return {
    student_id: studentId,
    current_year_pending: standing.currentYearPending,
    years_counted: standing.years.length,
    applies: applies(set, standing),
    ...evaluateSet(set, standing),
  };
}

/**
 * Students of a grade level in a year who are not on track: an applying set not met, or not met
 * yet (pending) while their year is in progress.
 */
export async function graduationReport(
  tx: TransactionSql,
  schoolId: string,
  academicYearId: string,
  gradeLevelId: string,
): Promise<GraduationReportView> {
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
  const sets = await loadSets(tx, schoolId, { activeOnly: true });
  const standings =
    students.length === 0 || sets.length === 0
      ? new Map<string, StudentStanding>()
      : await loadStandings(
          tx,
          schoolId,
          students.map((student) => student.student_id),
          academicYearId,
        );

  let checked = 0;
  const behind: GraduationReportView["students"] = [];
  for (const student of students) {
    const standing = standings.get(student.student_id);
    if (!standing) continue;
    const applying = sets.filter((set) => applies(set, standing));
    if (applying.length === 0) continue;
    checked += 1;
    const unmet = applying
      .map((set) => evaluateSet(set, standing))
      .filter((evaluation) => evaluation.status !== "met");
    if (unmet.length === 0) continue;
    behind.push({
      ...student,
      status: unmet.some((evaluation) => evaluation.status === "not_met") ? "not_met" : "pending",
      sets: unmet,
    });
  }
  // Not met first; the students query already ordered each group by name.
  behind.sort((a, b) => Number(a.status !== "not_met") - Number(b.status !== "not_met"));
  return {
    academic_year_id: academicYearId,
    grade_level_id: gradeLevelId,
    students_checked: checked,
    students: behind,
  };
}

/** The outcome of every set applying to the student, for a transcript being issued. */
export async function transcriptGraduationRequirements(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<TranscriptGraduationRequirement[]> {
  const sets = await loadSets(tx, schoolId, { activeOnly: true });
  if (sets.length === 0) return [];
  const standing = (await loadStandings(tx, schoolId, [studentId])).get(studentId)!;
  return sets
    .filter((set) => applies(set, standing))
    .map((set) => {
      const evaluation = evaluateSet(set, standing);
      return {
        name: set.view.name,
        status: evaluation.status,
        rules_met: evaluation.rules_met,
        rules_total: evaluation.rules_total,
      };
    });
}
