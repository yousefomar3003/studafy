import { ERROR_CODES } from "@studafy/constants";
import { calculateMultiYearResult, validateMultiYearYears } from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { assertCanReadStudent } from "../external-exams/service";
import { readsAsFamily } from "../graduation-requirements/service";

import type {
  MultiYearStatus,
  MultiYearYearInput,
  MultiYearYearStatus,
  RoundingRule,
} from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * Multi-year results (000266): a result weighted across several grade levels ("Grade 11 40% +
 * Grade 12 60%"), per subject and overall, worked out on read from each year's current finalized
 * annual result by @studafy/grading-engine. Pending while a year is not finalized.
 *
 * School leadership manages the configurations (academicConfig:manage); staff with
 * academicConfig:read read them. A student's results are read by whoever may read the student
 * (app.can_read_student), and the student and their parents see only the configurations shown to
 * them. A configuration applies to a student when it is active and lists the grade level of their
 * latest placement (without one, of their latest finalized year).
 */

// ---------------------------------------------------------------------------
// Views and inputs
// ---------------------------------------------------------------------------

export interface MultiYearConfigView {
  id: string;
  name: string;
  is_active: boolean;
  visible_to_students_and_parents: boolean;
  years: { grade_level: { id: string; name: string }; weight: number }[];
  created_at: string;
  updated_at: string;
}

export interface MultiYearConfigInput {
  name: string;
  is_active?: boolean | undefined;
  visible_to_students_and_parents?: boolean | undefined;
  years: { grade_level_id: string; weight: number }[];
}

export interface MultiYearStudentResultView {
  config: { id: string; name: string; visible_to_students_and_parents: boolean };
  status: MultiYearStatus;
  overall_percentage: number | null;
  years: {
    grade_level: { id: string; name: string };
    weight: number;
    share: number;
    status: MultiYearYearStatus;
    academic_year: { id: string; name: string } | null;
    overall_percentage: number | null;
  }[];
  subjects: {
    subject_id: string;
    code: string;
    name: string;
    percentage: number | null;
    years_counted: number;
    by_year: { grade_level_id: string; percentage: number | null }[];
  }[];
}

export interface StudentMultiYearResultsView {
  student_id: string;
  results: MultiYearStudentResultView[];
}

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
// Configurations
// ---------------------------------------------------------------------------

interface LoadedConfig {
  view: MultiYearConfigView;
  /** Grade level id -> sort order, for "has the student reached it yet". */
  gradeOrder: Map<string, number>;
}

async function loadConfigs(
  tx: TransactionSql,
  schoolId: string,
  filter: { configId?: string; activeOnly?: boolean } = {},
): Promise<LoadedConfig[]> {
  const idClause = filter.configId ? tx`AND config.id = ${filter.configId}::uuid` : tx``;
  const activeClause = filter.activeOnly ? tx`AND config.is_active` : tx``;
  const configs = await tx<
    {
      id: string;
      name: string;
      is_active: boolean;
      visible_to_students_and_parents: boolean;
      created_at: Date;
      updated_at: Date;
    }[]
  >`
    SELECT config.id, config.name, config.is_active, config.visible_to_students_and_parents,
           config.created_at, config.updated_at
    FROM app.multi_year_result_configs AS config
    WHERE config.school_id = ${schoolId}::uuid ${idClause} ${activeClause}
    ORDER BY config.name, config.id
  `;
  if (configs.length === 0) return [];
  const years = await tx<
    { config_id: string; id: string; name: string; sort_order: number; weight: string }[]
  >`
    SELECT year.config_id, grade.id, grade.name, grade.sort_order, year.weight::text AS weight
    FROM app.multi_year_result_config_years AS year
    JOIN app.grade_levels AS grade
      ON grade.id = year.grade_level_id AND grade.school_id = year.school_id
    WHERE year.school_id = ${schoolId}::uuid
      AND year.config_id = ANY (${configs.map((config) => config.id)}::uuid[])
    ORDER BY year.sort_order, grade.sort_order, grade.name
  `;
  return configs.map((config) => {
    const own = years.filter((year) => year.config_id === config.id);
    return {
      gradeOrder: new Map(own.map((year) => [year.id, year.sort_order])),
      view: {
        id: config.id,
        name: config.name,
        is_active: config.is_active,
        visible_to_students_and_parents: config.visible_to_students_and_parents,
        years: own.map((year) => ({
          grade_level: { id: year.id, name: year.name },
          weight: Number(year.weight),
        })),
        created_at: config.created_at.toISOString(),
        updated_at: config.updated_at.toISOString(),
      },
    };
  });
}

export async function listMultiYearConfigs(
  tx: TransactionSql,
  schoolId: string,
): Promise<MultiYearConfigView[]> {
  return (await loadConfigs(tx, schoolId)).map((config) => config.view);
}

async function requireConfig(
  tx: TransactionSql,
  schoolId: string,
  configId: string,
): Promise<LoadedConfig> {
  const [config] = await loadConfigs(tx, schoolId, { configId });
  if (!config) notFound("Multi-year result configuration not found");
  return config;
}

async function checkInput(
  tx: TransactionSql,
  schoolId: string,
  input: MultiYearConfigInput,
): Promise<void> {
  const issues = validateMultiYearYears(
    input.years.map((year) => ({ key: year.grade_level_id, weight: year.weight })),
  );
  if (issues.length > 0) invalid(issues.map((issue) => issue.message).join(" "));
  const ids = input.years.map((year) => year.grade_level_id);
  const [row] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.grade_levels
    WHERE school_id = ${schoolId}::uuid AND id = ANY (${ids}::uuid[])
  `;
  if (row?.count !== ids.length) invalid("Unknown grade level");
}

function duplicateName(name: string): never {
  throw new CodedHttpException(
    409,
    ERROR_CODES.CONFLICT_DUPLICATE_ENTRY,
    `The school already has a multi-year result named "${name}"`,
  );
}

async function writeYears(
  tx: TransactionSql,
  schoolId: string,
  configId: string,
  years: MultiYearConfigInput["years"],
): Promise<void> {
  await tx`
    DELETE FROM app.multi_year_result_config_years
    WHERE school_id = ${schoolId}::uuid AND config_id = ${configId}::uuid
  `;
  for (const [index, year] of years.entries()) {
    await tx`
      INSERT INTO app.multi_year_result_config_years (
        school_id, config_id, grade_level_id, weight, sort_order
      )
      VALUES (${schoolId}::uuid, ${configId}::uuid, ${year.grade_level_id}::uuid, ${year.weight},
              ${index})
    `;
  }
}

const inputSummary = (input: MultiYearConfigInput) => ({
  name: input.name,
  is_active: input.is_active ?? true,
  visible_to_students_and_parents: input.visible_to_students_and_parents ?? false,
  years: input.years.map((year) => ({ grade_level_id: year.grade_level_id, weight: year.weight })),
});

const viewSummary = (view: MultiYearConfigView) => ({
  name: view.name,
  is_active: view.is_active,
  visible_to_students_and_parents: view.visible_to_students_and_parents,
  years: view.years.map((year) => ({ grade_level_id: year.grade_level.id, weight: year.weight })),
});

export async function createMultiYearConfig(
  tx: TransactionSql,
  schoolId: string,
  input: MultiYearConfigInput,
): Promise<MultiYearConfigView> {
  await checkInput(tx, schoolId, input);
  let configId: string;
  try {
    const [row] = await tx.savepoint(
      (sp) => sp<{ id: string }[]>`
        INSERT INTO app.multi_year_result_configs (
          school_id, name, is_active, visible_to_students_and_parents
        )
        VALUES (${schoolId}::uuid, ${input.name}, ${input.is_active ?? true},
                ${input.visible_to_students_and_parents ?? false})
        RETURNING id
      `,
    );
    configId = row!.id;
  } catch (error) {
    if (isPgError(error, "23505")) duplicateName(input.name);
    throw error;
  }
  await writeYears(tx, schoolId, configId, input.years);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "multi_year_result_configs",
    targetId: configId,
    newValues: inputSummary(input),
  });
  return (await requireConfig(tx, schoolId, configId)).view;
}

export async function updateMultiYearConfig(
  tx: TransactionSql,
  schoolId: string,
  configId: string,
  input: MultiYearConfigInput,
): Promise<MultiYearConfigView> {
  const before = await requireConfig(tx, schoolId, configId);
  await checkInput(tx, schoolId, input);
  try {
    await tx.savepoint(
      (sp) => sp`
        UPDATE app.multi_year_result_configs
        SET name = ${input.name},
            is_active = ${input.is_active ?? true},
            visible_to_students_and_parents = ${input.visible_to_students_and_parents ?? false},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${configId}::uuid AND school_id = ${schoolId}::uuid
      `,
    );
  } catch (error) {
    if (isPgError(error, "23505")) duplicateName(input.name);
    throw error;
  }
  await writeYears(tx, schoolId, configId, input.years);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "multi_year_result_configs",
    targetId: configId,
    oldValues: viewSummary(before.view),
    newValues: inputSummary(input),
  });
  return (await requireConfig(tx, schoolId, configId)).view;
}

export async function deleteMultiYearConfig(
  tx: TransactionSql,
  schoolId: string,
  configId: string,
): Promise<void> {
  const before = await requireConfig(tx, schoolId, configId);
  await tx`
    DELETE FROM app.multi_year_result_configs
    WHERE id = ${configId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "multi_year_result_configs",
    targetId: configId,
    oldValues: viewSummary(before.view),
  });
}

// ---------------------------------------------------------------------------
// A student's results
// ---------------------------------------------------------------------------

interface FinalizedYear {
  finalization_id: string;
  academic_year_id: string;
  year_name: string;
  starts_on: Date;
  grade_level_id: string;
  status: "complete" | "incomplete";
  average_percentage: string | null;
}

interface SubjectRow {
  finalization_id: string;
  subject_id: string;
  code: string | null;
  name: string | null;
  percentage: string | null;
  rounding: RoundingRule | null;
}

/**
 * The student's current annual finalization of every academic year (two in one year keep the
 * later), with the grade level of its section, and their latest placement.
 */
async function loadStudentYears(tx: TransactionSql, schoolId: string, studentId: string) {
  const finalizations = await tx<FinalizedYear[]>`
    SELECT DISTINCT ON (finalization.academic_year_id)
           finalization.id AS finalization_id, finalization.academic_year_id,
           year.name AS year_name, year.starts_on, section.grade_level_id, overall.status,
           overall.average_percentage::text AS average_percentage
    FROM app.student_overall_results AS overall
    JOIN app.result_finalizations AS finalization
      ON finalization.id = overall.finalization_id AND finalization.school_id = overall.school_id
    JOIN app.academic_years AS year
      ON year.id = finalization.academic_year_id AND year.school_id = finalization.school_id
    JOIN app.sections AS section
      ON section.id = finalization.section_id AND section.school_id = finalization.school_id
    WHERE overall.school_id = ${schoolId}::uuid AND overall.student_id = ${studentId}::uuid
      AND finalization.term_id IS NULL AND finalization.status = 'finalized'
    ORDER BY finalization.academic_year_id, finalization.finalized_at DESC, finalization.id
  `;
  const subjects =
    finalizations.length === 0
      ? []
      : await tx<SubjectRow[]>`
          SELECT result.finalization_id, result.subject_id,
                 result.config_snapshot->'subject'->>'code' AS code,
                 result.config_snapshot->'subject'->>'name' AS name,
                 CASE WHEN result.status = 'complete' AND NOT result.is_descriptive
                      THEN result.percentage::text END AS percentage,
                 result.config_snapshot->'program'->'rounding' AS rounding
          FROM app.student_subject_results AS result
          WHERE result.school_id = ${schoolId}::uuid AND result.student_id = ${studentId}::uuid
            AND result.finalization_id = ANY (${finalizations.map((f) => f.finalization_id)}::uuid[])
        `;
  const [placement] = await tx<{ grade_level_id: string; sort_order: number }[]>`
    SELECT section.grade_level_id, grade.sort_order
    FROM app.student_sections AS placement
    JOIN app.sections AS section
      ON section.id = placement.section_id AND section.school_id = placement.school_id
    JOIN app.grade_levels AS grade
      ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    JOIN app.academic_years AS year
      ON year.id = placement.academic_year_id AND year.school_id = placement.school_id
    WHERE placement.school_id = ${schoolId}::uuid AND placement.student_id = ${studentId}::uuid
    ORDER BY year.starts_on DESC
    LIMIT 1
  `;
  finalizations.sort((a, b) => a.starts_on.getTime() - b.starts_on.getTime());
  return { finalizations, subjects, placement: placement ?? null };
}

type StudentYears = Awaited<ReturnType<typeof loadStudentYears>>;

function evaluate(config: LoadedConfig, data: StudentYears): MultiYearStudentResultView {
  const latestGrade =
    data.placement?.grade_level_id ?? data.finalizations.at(-1)?.grade_level_id ?? null;
  const latestOrder =
    data.placement?.sort_order ?? (latestGrade ? config.gradeOrder.get(latestGrade) : undefined);
  let rounding = DEFAULT_ROUNDING;
  const names = new Map<string, { code: string; name: string }>();
  const used: (FinalizedYear | null)[] = [];

  const inputs: MultiYearYearInput[] = config.view.years.map((year) => {
    // A repeated grade: the later year counts.
    const finalized = data.finalizations.filter(
      (row) => row.grade_level_id === year.grade_level.id,
    );
    const row = finalized.at(-1) ?? null;
    used.push(row);
    if (!row) {
      const order = config.gradeOrder.get(year.grade_level.id);
      const notReached =
        latestOrder === undefined || order === undefined ? false : latestOrder <= order;
      return {
        key: year.grade_level.id,
        weight: year.weight,
        status: notReached ? "pending" : "missing",
        overallPercentage: null,
        subjects: [],
      };
    }
    const subjects = data.subjects.filter(
      (subject) => subject.finalization_id === row.finalization_id,
    );
    for (const subject of subjects) {
      names.set(subject.subject_id, { code: subject.code ?? "", name: subject.name ?? "" });
      if (subject.rounding) rounding = subject.rounding;
    }
    return {
      key: year.grade_level.id,
      weight: year.weight,
      status: row.status === "complete" ? "finalized" : "incomplete",
      overallPercentage: row.status === "complete" ? num(row.average_percentage) : null,
      subjects: subjects.map((subject) => ({
        subjectId: subject.subject_id,
        percentage: num(subject.percentage),
      })),
    };
  });
  const result = calculateMultiYearResult(inputs, rounding);
  return {
    config: {
      id: config.view.id,
      name: config.view.name,
      visible_to_students_and_parents: config.view.visible_to_students_and_parents,
    },
    status: result.status,
    overall_percentage: result.overallPercentage,
    years: config.view.years.map((year, index) => {
      const row = used[index] ?? null;
      return {
        grade_level: year.grade_level,
        weight: year.weight,
        share: result.shares[index] ?? 0,
        status: inputs[index]!.status,
        academic_year: row ? { id: row.academic_year_id, name: row.year_name } : null,
        overall_percentage: inputs[index]!.overallPercentage,
      };
    }),
    subjects: result.subjects
      .map((subject) => ({
        subject_id: subject.subjectId,
        code: names.get(subject.subjectId)?.code ?? "",
        name: names.get(subject.subjectId)?.name ?? "",
        percentage: subject.percentage,
        years_counted: subject.yearsCounted.length,
        by_year: config.view.years.map((year, index) => ({
          grade_level_id: year.grade_level.id,
          percentage: subject.byYear[index] ?? null,
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The student's result under every active configuration listing their grade level. */
export async function studentMultiYearResults(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<StudentMultiYearResultsView> {
  await assertCanReadStudent(tx, studentId);
  const [student] = await tx<{ id: string }[]>`
    SELECT id FROM app.students WHERE id = ${studentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  // Leadership of another school passes the role check; the student is not in their school.
  if (!student) notFound("Student not found");
  const familyOnly = await readsAsFamily(tx, studentId);
  const configs = await loadConfigs(tx, schoolId, { activeOnly: true });
  if (configs.length === 0) return { student_id: studentId, results: [] };
  const data = await loadStudentYears(tx, schoolId, studentId);
  const grade = data.placement?.grade_level_id ?? data.finalizations.at(-1)?.grade_level_id;
  return {
    student_id: studentId,
    results: configs
      .filter(
        (config) =>
          grade !== undefined &&
          config.gradeOrder.has(grade) &&
          (!familyOnly || config.view.visible_to_students_and_parents),
      )
      .map((config) => evaluate(config, data)),
  };
}
