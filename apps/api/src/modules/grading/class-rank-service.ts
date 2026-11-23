import { ERROR_CODES } from "@studafy/constants";
import { calculateRanks, topRanked } from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";

import { requireYear } from "./access";
import { requireProgram } from "./engine-config";

import type { RankVisibility } from "./engine-config";
import type { StoredStudentResult } from "./results-service";
import type {
  RankBasis,
  RankCandidate,
  RankOutcome,
  RankScope,
  RankedStudent,
  RoundingMode,
  RoundingRule,
} from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * Class rank and percentile (000257), computed when read.
 *
 * A grade program says whether its students are ranked, by what (average, GPA, weighted GPA),
 * against whom (their section, or the whole grade level) and who may see it. The rank itself is
 * never stored on a result: it is worked out from the current (not superseded) finalized overall
 * results of the period — a term, or the year — which change only through audited corrections.
 * The rules (ties, rounding, percentile, who is ranked) live in `@studafy/grading-engine`.
 *
 * Every cohort is read in two queries whatever its size: the grade's sections with their current
 * finalization of the period, then the overall results of those finalizations. A grade-level rank
 * exists only once every section of the grade that has students is finalized for the period;
 * until then it is `pending` — never a rank among the sections that happen to be done.
 *
 * Issued report cards, certificates and transcripts keep the rank they were issued with in their
 * immutable content (see {@link documentClassRank}).
 */

export interface ClassRank {
  /** ranked: rank, cohort and percentile set. not_ranked: incomplete result. pending: see above. */
  status: "ranked" | "not_ranked" | "pending";
  basis: RankBasis;
  scope: RankScope;
  rank: number | null;
  cohort_size: number | null;
  percentile: number | null;
}

/** A rank as an issued document keeps it: only when the student was ranked. */
export interface DocumentClassRank {
  rank: number;
  cohort_size: number;
  percentile: number;
  basis: RankBasis;
  scope: RankScope;
}

/**
 * Who is reading: staff always see an enabled rank; a student or parent, and the documents issued
 * to them, only when the grade's rank is visible to students and parents.
 */
export type RankAudience = "staff" | "student_or_parent" | "document";

export interface RankSettings {
  enabled: boolean;
  basis: RankBasis;
  scope: RankScope;
  visibility: RankVisibility;
  /** The grade's overall rounding: values are compared as the grade shows them. */
  rounding: RoundingRule;
}

interface FinalizationRankContext {
  id: string;
  academic_year_id: string;
  section_id: string;
  grade_level_id: string;
  term_id: string | null;
  status: "finalized" | "superseded";
  settings: RankSettings | null;
}

interface SettingsRow {
  rank_enabled: boolean | null;
  rank_basis: RankBasis | null;
  rank_scope: RankScope | null;
  rank_visibility: RankVisibility | null;
  average_rounding_decimals: number | null;
  average_rounding_mode: RoundingMode | null;
}

function settingsFrom(row: SettingsRow): RankSettings | null {
  if (row.rank_enabled === null) return null;
  return {
    enabled: row.rank_enabled,
    basis: row.rank_basis!,
    scope: row.rank_scope!,
    visibility: row.rank_visibility!,
    rounding: { decimals: row.average_rounding_decimals!, mode: row.average_rounding_mode! },
  };
}

function visibleTo(settings: RankSettings, audience: RankAudience): boolean {
  return audience === "staff" || settings.visibility === "students_and_parents";
}

/** The rank settings of each finalization's grade, with what locates its cohort. One query. */
async function loadRankContexts(
  tx: TransactionSql,
  schoolId: string,
  finalizationIds: readonly string[],
): Promise<Map<string, FinalizationRankContext>> {
  if (finalizationIds.length === 0) return new Map();
  const rows = await tx<(Omit<FinalizationRankContext, "settings"> & SettingsRow)[]>`
    SELECT finalization.id, finalization.academic_year_id, finalization.section_id,
           section.grade_level_id, finalization.term_id, finalization.status,
           program.rank_enabled, program.rank_basis, program.rank_scope, program.rank_visibility,
           program.average_rounding_decimals, program.average_rounding_mode
    FROM app.result_finalizations AS finalization
    JOIN app.sections AS section
      ON section.id = finalization.section_id AND section.school_id = finalization.school_id
    LEFT JOIN app.grade_programs AS program
      ON program.school_id = finalization.school_id
     AND program.academic_year_id = finalization.academic_year_id
     AND program.grade_level_id = section.grade_level_id
    WHERE finalization.school_id = ${schoolId}::uuid
      AND finalization.id = ANY (${finalizationIds as string[]}::uuid[])
  `;
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        academic_year_id: row.academic_year_id,
        section_id: row.section_id,
        grade_level_id: row.grade_level_id,
        term_id: row.term_id,
        status: row.status,
        settings: settingsFrom(row),
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

interface PeriodSection {
  id: string;
  name: string;
  /** Not archived and has students: the grade-level rank waits for it. */
  required: boolean;
  finalization_id: string | null;
}

export interface CohortRow {
  /** The row's ranking key: finalization|student, or finalization|anonymous-n. */
  key: string;
  finalization_id: string;
  section_id: string;
  /** Null for a classmate whose result the caller may not read: ranked, but never named. */
  student_id: string | null;
  status: "complete" | "incomplete";
  average_percentage: string | null;
  result_format: string | null;
  result_value: string | null;
  weighted_result_value: string | null;
}

interface PeriodResults {
  sections: PeriodSection[];
  rows: CohortRow[];
}

interface PeriodKey {
  yearId: string;
  gradeLevelId: string;
  termId: string | null;
  /** Only this section (a section-scope cohort); every section of the grade when absent. */
  sectionId?: string;
}

/**
 * One cohort's sections and results, through app.class_rank_cohort (000257): a student or parent
 * may not read classmates' results, yet their rank depends on them. The function returns nothing
 * unless the grade ranks and the caller is leadership or the rank is visible to students and
 * parents; it counts a student finalized in two sections (a move) once, with the later result,
 * and names only the students whose results the caller may read. One query per cohort.
 */
async function loadPeriodResults(tx: TransactionSql, key: PeriodKey): Promise<PeriodResults> {
  const rows = await tx<
    (Omit<CohortRow, "finalization_id" | "section_id" | "status"> & {
      section_id: string;
      section_name: string;
      section_required: boolean;
      finalization_id: string | null;
      status: CohortRow["status"] | null;
    })[]
  >`
    SELECT section_id, section_name, section_required, finalization_id, student_id, status,
           average_percentage, result_format, result_value, weighted_result_value
    FROM app.class_rank_cohort(
      ${key.yearId}::uuid, ${key.gradeLevelId}::uuid, ${key.termId}::uuid,
      ${key.sectionId ?? null}::uuid
    )
  `;
  const sections = new Map<string, PeriodSection>();
  const results: CohortRow[] = [];
  for (const row of rows) {
    if (!sections.has(row.section_id)) {
      sections.set(row.section_id, {
        id: row.section_id,
        name: row.section_name,
        required: row.section_required,
        finalization_id: row.finalization_id,
      });
    }
    if (row.finalization_id !== null && row.status !== null) {
      results.push({
        // A classmate the caller may not read still takes their place, under an anonymous key.
        key: rowKey(row.finalization_id, row.student_id ?? `anonymous-${results.length}`),
        finalization_id: row.finalization_id,
        section_id: row.section_id,
        student_id: row.student_id,
        status: row.status,
        average_percentage: row.average_percentage,
        result_format: row.result_format,
        result_value: row.result_value,
        weighted_result_value: row.weighted_result_value,
      });
    }
  }
  return { sections: [...sections.values()], rows: results };
}

const num = (value: string | null): number | null => (value === null ? null : Number(value));

/** Ranking's key for one result: a student can be in two finalizations of a period (a move). */
const rowKey = (finalizationId: string, studentId: string) => `${finalizationId}|${studentId}`;

function candidateOf(row: CohortRow): RankCandidate {
  return {
    id: row.key,
    status: row.status,
    averagePercentage: num(row.average_percentage),
    gpa: row.result_format === "gpa" ? num(row.result_value) : null,
    weightedGpa: row.result_format === "gpa" ? num(row.weighted_result_value) : null,
  };
}

function rankRows(rows: readonly CohortRow[], settings: RankSettings): RankOutcome {
  return calculateRanks(rows.map(candidateOf), {
    basis: settings.basis,
    rounding: settings.rounding,
  });
}

export interface Cohort {
  status: "ranked" | "pending";
  /** Sections the grade-level rank still waits for. */
  pending_sections: { section_id: string; section_name: string }[];
  outcome: RankOutcome | null;
  /** The outcome's ranked students by finalization|student. */
  ranked: Map<string, RankedStudent>;
  rows: CohortRow[];
}

function cohortOf(results: PeriodResults, settings: RankSettings): Cohort {
  const pending = results.sections
    .filter((section) => section.required && section.finalization_id === null)
    .map((section) => ({ section_id: section.id, section_name: section.name }));
  if (pending.length > 0) {
    return {
      status: "pending",
      pending_sections: pending,
      outcome: null,
      ranked: new Map(),
      rows: results.rows,
    };
  }
  const outcome = rankRows(results.rows, settings);
  return {
    status: "ranked",
    pending_sections: [],
    outcome,
    ranked: new Map(outcome.ranked.map((student) => [student.id, student])),
    rows: results.rows,
  };
}

function rankFor(
  cohort: Cohort,
  settings: RankSettings,
  finalizationId: string,
  studentId: string,
): ClassRank {
  const base = { basis: settings.basis, scope: settings.scope };
  if (cohort.status === "pending" || !cohort.outcome) {
    return { ...base, status: "pending", rank: null, cohort_size: null, percentile: null };
  }
  const ranked = cohort.ranked.get(rowKey(finalizationId, studentId));
  return ranked
    ? {
        ...base,
        status: "ranked",
        rank: ranked.rank,
        cohort_size: cohort.outcome.cohortSize,
        percentile: ranked.percentile,
      }
    : {
        ...base,
        status: "not_ranked",
        rank: null,
        cohort_size: cohort.outcome.cohortSize,
        percentile: null,
      };
}

/**
 * Set `class_rank` on stored results of some finalizations, for one audience. Results of a
 * superseded finalization, of a grade that does not rank, or that the audience may not see get
 * null. Cohorts shared by several finalizations are read once.
 */
export async function attachClassRanks(
  tx: TransactionSql,
  schoolId: string,
  items: readonly { finalizationId: string; results: StoredStudentResult[] }[],
  audience: RankAudience,
): Promise<void> {
  const contexts = await loadRankContexts(
    tx,
    schoolId,
    items.map((item) => item.finalizationId),
  );
  const cohorts = new Map<string, Cohort>();
  for (const item of items) {
    const context = contexts.get(item.finalizationId);
    const settings = context?.settings;
    if (
      !context ||
      !settings?.enabled ||
      context.status !== "finalized" ||
      !visibleTo(settings, audience)
    ) {
      for (const result of item.results) result.class_rank = null;
      continue;
    }
    const sectionId = settings.scope === "section" ? context.section_id : undefined;
    const cacheKey = [
      context.academic_year_id,
      context.grade_level_id,
      context.term_id,
      sectionId,
    ].join("|");
    let cohort = cohorts.get(cacheKey);
    if (!cohort) {
      cohort = cohortOf(
        await loadPeriodResults(tx, {
          yearId: context.academic_year_id,
          gradeLevelId: context.grade_level_id,
          termId: context.term_id,
          sectionId,
        }),
        settings,
      );
      cohorts.set(cacheKey, cohort);
    }
    for (const result of item.results) {
      result.class_rank = rankFor(cohort, settings, item.finalizationId, result.student_id);
    }
  }
}

/** The rank an issued document keeps: absent unless the student was ranked. */
export function documentClassRank(rank: ClassRank | null): DocumentClassRank | undefined {
  if (rank?.status !== "ranked") return undefined;
  return {
    rank: rank.rank!,
    cohort_size: rank.cohort_size!,
    percentile: rank.percentile!,
    basis: rank.basis,
    scope: rank.scope,
  };
}

// ---------------------------------------------------------------------------
// Top students
// ---------------------------------------------------------------------------

export interface TopStudent {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_number: string;
  section_id: string;
  section_name: string;
  rank: number;
  percentile: number;
  /** The value ranked by, as compared: the average percentage or the GPA. */
  value: number;
}

export interface TopStudentsGroup {
  /** The section ranked (section scope); null for the whole grade level. */
  section_id: string | null;
  section_name: string | null;
  status: "ranked" | "pending";
  pending_sections: { section_id: string; section_name: string }[];
  cohort_size: number | null;
  students: TopStudent[];
}

export interface TopStudents {
  academic_year_id: string;
  grade_level_id: string;
  grade_level_name: string;
  term_id: string | null;
  enabled: boolean;
  basis: RankBasis;
  scope: RankScope;
  visibility: RankVisibility;
  groups: TopStudentsGroup[];
}

interface StudentName {
  first_name: string;
  last_name: string;
  admission_number: string;
}

/** A cohort's top places, before names are filled in. */
function topGroup(
  cohort: Cohort,
  section: { id: string; name: string } | null,
  limit: number,
): { group: Omit<TopStudentsGroup, "students">; top: { row: CohortRow; ranked: RankedStudent }[] } {
  const head = { section_id: section?.id ?? null, section_name: section?.name ?? null };
  if (cohort.status === "pending" || !cohort.outcome) {
    return {
      group: {
        ...head,
        status: "pending",
        pending_sections: cohort.pending_sections,
        cohort_size: null,
      },
      top: [],
    };
  }
  const byKey = new Map(cohort.rows.map((row) => [row.key, row]));
  return {
    group: {
      ...head,
      status: "ranked",
      pending_sections: [],
      cohort_size: cohort.outcome.cohortSize,
    },
    top: topRanked(cohort.outcome, limit).map((ranked) => ({ row: byKey.get(ranked.id)!, ranked })),
  };
}

/**
 * The best `limit` places (ties included) of a grade level for a term or the year: one list for a
 * grade-level rank, one per section for a section rank. Empty while the grade does not rank.
 * School leadership only (the route's permission); every student is named.
 */
export async function topStudents(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  gradeLevelId: string,
  termId: string | null,
  limit: number,
): Promise<TopStudents> {
  await requireYear(tx, schoolId, yearId);
  const program = await requireProgram(tx, schoolId, yearId, gradeLevelId);
  if (termId !== null) {
    const [term] = await tx<{ id: string }[]>`
      SELECT id FROM app.terms
      WHERE id = ${termId}::uuid AND school_id = ${schoolId}::uuid
        AND academic_year_id = ${yearId}::uuid
    `;
    if (!term) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        "Term not found in this year",
      );
    }
  }
  const settings: RankSettings = {
    enabled: program.rank_enabled,
    basis: program.rank_basis,
    scope: program.rank_scope,
    visibility: program.rank_visibility,
    rounding: {
      decimals: program.average_rounding_decimals,
      mode: program.average_rounding_mode,
    },
  };
  const head = {
    academic_year_id: yearId,
    grade_level_id: gradeLevelId,
    grade_level_name: program.grade_level_name,
    term_id: termId,
    enabled: settings.enabled,
    basis: settings.basis,
    scope: settings.scope,
    visibility: settings.visibility,
  };
  if (!settings.enabled) return { ...head, groups: [] };

  const grade = await loadPeriodResults(tx, { yearId, gradeLevelId, termId });
  const sectionNames = new Map(grade.sections.map((section) => [section.id, section.name]));
  let groups: ReturnType<typeof topGroup>[];
  if (settings.scope === "grade_level") {
    groups = [topGroup(cohortOf(grade, settings), null, limit)];
  } else {
    // Section scope: each section with students or results is its own cohort, read on its own so
    // a student who moved counts in both sections, exactly as on their results.
    groups = [];
    for (const section of grade.sections) {
      if (!section.required && section.finalization_id === null) continue;
      const cohort =
        section.finalization_id === null
          ? cohortOf({ sections: [section], rows: [] }, settings)
          : cohortOf(
              await loadPeriodResults(tx, { yearId, gradeLevelId, termId, sectionId: section.id }),
              settings,
            );
      groups.push(topGroup(cohort, section, limit));
    }
  }

  const studentIds = [
    ...new Set(groups.flatMap((group) => group.top.map(({ row }) => row.student_id!))),
  ];
  const names = new Map<string, StudentName>();
  if (studentIds.length > 0) {
    const rows = await tx<(StudentName & { id: string })[]>`
      SELECT id, first_name, last_name, admission_number FROM app.students
      WHERE school_id = ${schoolId}::uuid AND id = ANY (${studentIds}::uuid[])
    `;
    for (const row of rows) names.set(row.id, row);
  }
  return {
    ...head,
    groups: groups.map(({ group, top }) => ({
      ...group,
      students: top
        .map(({ row, ranked }) => {
          const name = names.get(row.student_id!);
          return {
            student_id: row.student_id!,
            first_name: name?.first_name ?? "",
            last_name: name?.last_name ?? "",
            admission_number: name?.admission_number ?? "",
            section_id: row.section_id,
            section_name: sectionNames.get(row.section_id) ?? "",
            rank: ranked.rank,
            percentile: ranked.percentile,
            value: ranked.value,
          };
        })
        // Best first; tied students by name.
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            a.last_name.localeCompare(b.last_name) ||
            a.first_name.localeCompare(b.first_name),
        ),
    })),
  };
}
