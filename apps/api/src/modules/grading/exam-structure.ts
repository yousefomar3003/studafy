import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { assertConfigEditable, isSchoolLeadership, requireYear } from "./access";
import { getConfigImpact, getConfigView, updateSubjectConfig } from "./config-service";
import { loadYearTerms } from "./engine-config";

import type {
  AssessmentInput,
  CategoryInput,
  ConfigView,
  SubjectConfigInput,
} from "./config-service";
import type { TransactionSql } from "postgres";

/**
 * The school's exam system (School Settings, migration 000174) turned into a subject's term
 * structure: every term gets one category per part of the system, weighted as the admin set it,
 * with one assessment each, marked out of that part's share (a 30% midterm is marked out of 30).
 * Terms share the year equally. A part the admin set to 0% is left out.
 *
 *   midterm  midterm exam, final exam, quizzes, homework
 *   periods  first period exam, second period exam, final exam, quizzes, homework
 *
 * New subjects start from it (`GET .../exam-template`, prefilled by the web editor); "apply to all
 * subjects" rebuilds the active year's subjects that have no marks yet.
 */

export type ExamStructure = "midterm" | "periods";
export type ExamPart =
  "first_period" | "second_period" | "midterm" | "final_exam" | "quiz" | "homework";
export type ExamWeights = Partial<Record<ExamPart, number>>;

export const EXAM_STRUCTURES: readonly ExamStructure[] = ["midterm", "periods"];

/** Each system's parts, in the order a term shows them. */
export const EXAM_STRUCTURE_PARTS: Record<ExamStructure, readonly ExamPart[]> = {
  midterm: ["midterm", "final_exam", "quiz", "homework"],
  periods: ["first_period", "second_period", "final_exam", "quiz", "homework"],
};

export const DEFAULT_EXAM_WEIGHTS: Record<ExamStructure, ExamWeights> = {
  midterm: { midterm: 30, final_exam: 40, quiz: 15, homework: 15 },
  periods: { first_period: 20, second_period: 20, final_exam: 30, quiz: 15, homework: 15 },
};

const PART_NAMES: Record<"en" | "ar", Record<ExamPart, string>> = {
  en: {
    first_period: "First period exam",
    second_period: "Second period exam",
    midterm: "Midterm exam",
    final_exam: "Final exam",
    quiz: "Quizzes",
    homework: "Homework",
  },
  ar: {
    first_period: "اختبار الفترة الأولى",
    second_period: "اختبار الفترة الثانية",
    midterm: "اختبار منتصف الفصل",
    final_exam: "الاختبار النهائي",
    quiz: "الاختبارات القصيرة",
    homework: "الواجبات",
  },
};

/** Why a weights object does not fit its system, or null when it does. */
export function examWeightsProblem(structure: ExamStructure, weights: ExamWeights): string | null {
  // eslint-disable-next-line security/detect-object-injection -- `structure` is a closed union
  const parts = EXAM_STRUCTURE_PARTS[structure];
  const extra = Object.keys(weights).filter((key) => !parts.includes(key as ExamPart));
  if (extra.length > 0) return `${extra.join(", ")} is not part of the ${structure} system`;
  let total = 0;
  for (const part of parts) {
    // eslint-disable-next-line security/detect-object-injection -- `part` comes from a closed list
    const weight = weights[part];
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 100) {
      return `Give ${part} a weight between 0 and 100`;
    }
    total += weight;
  }
  if (Math.abs(total - 100) > 0.001) return `The weights total ${total}%; they must total 100%`;
  return null;
}

export interface ExamTemplate {
  structure: ExamStructure;
  weights: ExamWeights;
  term_weights: { term_id: string; weight: number }[];
  categories: CategoryInput[];
  assessments: AssessmentInput[];
}

/** The term structure for `termIds` (in order). Category refs are the part names. */
export function buildExamTemplate(
  structure: ExamStructure,
  weights: ExamWeights,
  termIds: readonly string[],
  locale: string,
): ExamTemplate {
  const names = PART_NAMES[locale === "ar" ? "ar" : "en"];
  // eslint-disable-next-line security/detect-object-injection -- `part` comes from a closed list
  const parts = EXAM_STRUCTURE_PARTS[structure].filter((part) => (weights[part] ?? 0) > 0);
  const share = Math.floor((100 / Math.max(termIds.length, 1)) * 100) / 100;
  return {
    structure,
    weights,
    term_weights: termIds.map((termId, index) => ({
      term_id: termId,
      // The last term takes the rounding remainder so the year totals exactly 100.
      weight:
        index === termIds.length - 1
          ? Math.round((100 - share * (termIds.length - 1)) * 100) / 100
          : share,
    })),
    categories: parts.map((part, index) => ({
      ref: part,
      // eslint-disable-next-line security/detect-object-injection -- closed list
      name: names[part],
      kind: part,
      scope: "term",
      // eslint-disable-next-line security/detect-object-injection -- closed list
      weight: weights[part]!,
      aggregation: "weighted_average",
      drop_lowest: 0,
      sort_order: index,
    })),
    assessments: termIds.flatMap((termId) =>
      parts.map((part, index) => ({
        category_ref: part,
        term_id: termId,
        // eslint-disable-next-line security/detect-object-injection -- closed list
        name: names[part],
        // eslint-disable-next-line security/detect-object-injection -- closed list
        max_marks: weights[part]!,
        weight: 1,
        is_mandatory: true,
        assessment_date: null,
        due_date: null,
        sort_order: index,
      })),
    ),
  };
}

interface SchoolExamSettings {
  exam_structure: ExamStructure;
  exam_weights: ExamWeights;
  locale: string;
}

async function loadExamSettings(tx: TransactionSql, schoolId: string): Promise<SchoolExamSettings> {
  const [row] = await tx<SchoolExamSettings[]>`
    SELECT exam_structure, exam_weights, locale
    FROM app.school_settings
    WHERE school_id = ${schoolId}::uuid
  `;
  // A school that never opened its settings has the column defaults.
  return (
    row ?? { exam_structure: "midterm", exam_weights: DEFAULT_EXAM_WEIGHTS.midterm, locale: "en" }
  );
}

/** The template a new subject in `yearId` starts from. */
export async function getExamTemplate(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<ExamTemplate> {
  await requireYear(tx, schoolId, yearId);
  const settings = await loadExamSettings(tx, schoolId);
  const terms = await loadYearTerms(tx, schoolId, yearId);
  return buildExamTemplate(
    settings.exam_structure,
    settings.exam_weights,
    terms.map((term) => term.id),
    settings.locale,
  );
}

export type ApplySkipReason = "has_marks" | "section_assessments" | "excluded" | "invalid";

export interface ApplyExamStructureResult {
  academic_year_id: string;
  academic_year_name: string;
  structure: ExamStructure;
  updated: { config_id: string; subject_name: string; section_id: string | null }[];
  skipped: {
    config_id: string;
    subject_name: string;
    section_id: string | null;
    reason: ApplySkipReason;
    detail: string | null;
  }[];
}

/** A config's own rules with the template's term structure in place of its own. */
function inputFrom(view: ConfigView, template: ExamTemplate): SubjectConfigInput {
  return {
    requirement: view.requirement,
    include_in_average: view.include_in_average,
    include_on_certificate: view.include_on_certificate,
    average_weight: view.average_weight,
    grading_method: "weighted",
    max_marks: view.max_marks,
    pass_percentage: view.pass_percentage,
    // A final-exam pass mark only makes sense while the template still has a final exam.
    final_exam_pass_percentage: template.categories.some((c) => c.kind === "final_exam")
      ? view.final_exam_pass_percentage
      : null,
    grade_scale_id: view.grade_scale_id,
    rounding_decimals: view.rounding_decimals,
    rounding_mode: view.rounding_mode,
    missing_mark_policy: view.missing_mark_policy,
    absent_policy: view.absent_policy,
    retake_policy: view.retake_policy,
    retake_cap_percentage: view.retake_cap_percentage,
    teachers_can_add_assessments: view.teachers_can_add_assessments,
    teacher_assessments_require_approval: view.teacher_assessments_require_approval,
    instructions: view.instructions,
    term_weights: template.term_weights,
    categories: template.categories,
    assessments: template.assessments,
  };
}

/**
 * Rebuild every subject of the school's active year on the exam system. A subject with recorded
 * marks is never touched (its marks belong to its current assessments); neither is a grade
 * default with section-only extra assessments, whose categories would disappear under them.
 */
export async function applyExamStructure(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
): Promise<ApplyExamStructureResult> {
  if (!(await isSchoolLeadership(tx))) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "Only school leadership can set up subjects",
    );
  }
  const [active] = await tx<{ id: string }[]>`
    SELECT id FROM app.academic_years
    WHERE school_id = ${schoolId}::uuid AND status = 'active'
    LIMIT 1
  `;
  if (!active) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ACADEMIC_YEAR_NOT_ACTIVE,
      "There is no active academic year to set up",
    );
  }
  const year = await requireYear(tx, schoolId, active.id);
  assertConfigEditable(year);
  const template = await getExamTemplate(tx, schoolId, year.id);
  if (template.term_weights.length === 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ACADEMIC_CONFIG_INVALID,
      `${year.name} has no terms yet; add its terms first`,
    );
  }

  const configs = await tx<{ id: string }[]>`
    SELECT config.id
    FROM app.subject_configs AS config
    JOIN app.subjects AS subject ON subject.id = config.subject_id AND subject.school_id = config.school_id
    WHERE config.school_id = ${schoolId}::uuid AND config.academic_year_id = ${year.id}::uuid
    ORDER BY config.section_id NULLS FIRST, subject.name
  `;

  // Each rebuilt subject's revision before the change, for the audit entry.
  const revisions: Record<string, number> = {};
  const result: ApplyExamStructureResult = {
    academic_year_id: year.id,
    academic_year_name: year.name,
    structure: template.structure,
    updated: [],
    skipped: [],
  };
  for (const { id } of configs) {
    const view = await getConfigView(tx, schoolId, id);
    const entry = { config_id: id, subject_name: view.subject.name, section_id: view.section_id };
    // eslint-disable-next-line security/detect-object-injection -- `id` is a config uuid from the query above
    revisions[id] = view.revision;
    if (view.is_excluded) {
      result.skipped.push({ ...entry, reason: "excluded", detail: null });
      continue;
    }
    const impact = await getConfigImpact(tx, schoolId, id);
    if (impact.mark_count > 0) {
      result.skipped.push({ ...entry, reason: "has_marks", detail: null });
      continue;
    }
    if (view.section_id === null && view.assessments.some((a) => a.section_id !== null)) {
      result.skipped.push({ ...entry, reason: "section_assessments", detail: null });
      continue;
    }
    // Each subject saves on its own savepoint, so one that the rules refuse is reported and the
    // rest still go through.
    try {
      await tx.savepoint((sp) =>
        updateSubjectConfig(sp, schoolId, userId, id, inputFrom(view, template), {
          confirmImpact: true,
        }),
      );
      result.updated.push(entry);
    } catch (error) {
      if (!(error instanceof CodedHttpException)) throw error;
      result.skipped.push({ ...entry, reason: "invalid", detail: error.message });
    }
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "subject_configs",
    targetId: year.id,
    oldValues: {
      revisions: Object.fromEntries(
        result.updated.map((row) => [row.config_id, revisions[row.config_id]]),
      ),
    },
    newValues: {
      event: "exam_structure_applied",
      structure: template.structure,
      weights: template.weights,
      updated: result.updated.map((row) => row.config_id),
      skipped: result.skipped.map((row) => ({ id: row.config_id, reason: row.reason })),
    },
  });
  return result;
}
