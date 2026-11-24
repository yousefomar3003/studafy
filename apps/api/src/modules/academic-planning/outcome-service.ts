import { ERROR_CODES } from "@studafy/constants";
import { parseCsv } from "@studafy/student-import";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import {
  assertCanGradeSectionSubject,
  assertCanReadSectionSubject,
  requireYear,
} from "../grading/access";
import {
  loadRoster,
  loadYearTerms,
  requireEffectiveSubject,
  requireSectionRow,
} from "../grading/engine-config";

import { getPlanningSettings } from "./settings-service";

import type { AchievementLevel } from "./settings-service";
import type { SectionSubjectAccess } from "../grading/access";
import type { TransactionSql } from "postgres";

/**
 * Learning outcomes (000267): the catalogue per subject and grade level, managed by school
 * leadership, and each student's achievement per outcome and period, entered by the subject
 * teacher. The subject's coordinator (000260) reads a section's achievement, never edits it.
 *
 * An outcome that achievement or a plan uses can no longer be deleted, only archived: archived
 * outcomes drop out of pickers but keep showing where they were used.
 */

export const OUTCOME_CODE_MAX = 40;
export const OUTCOME_TEXT_MAX = 1000;
export const OUTCOME_STRAND_MAX = 120;
export const OUTCOME_IMPORT_ROWS_MAX = 2000;

export interface LearningOutcome {
  id: string;
  subject_id: string;
  subject_code: string;
  subject_name: string;
  grade_level_id: string;
  grade_level_name: string;
  code: string;
  text: string;
  text_ar: string | null;
  strand: string | null;
  sort_order: number;
  archived: boolean;
  /** Used by achievement or a plan: archive rather than delete. */
  in_use: boolean;
  created_at: string;
  updated_at: string;
}

/** Trimmed text, or null for blank. */
function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function invalid(message: string): never {
  throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, message);
}

const OUTCOME_SELECT = (tx: TransactionSql) => tx`
  SELECT outcome.id, outcome.subject_id, subject.code AS subject_code, subject.name AS subject_name,
         outcome.grade_level_id, grade.name AS grade_level_name, outcome.code, outcome.text,
         outcome.text_ar, outcome.strand, outcome.sort_order, outcome.archived_at IS NOT NULL AS archived,
         (
           EXISTS (SELECT 1 FROM app.student_outcome_achievements AS used
                   WHERE used.school_id = outcome.school_id AND used.outcome_id = outcome.id)
           OR EXISTS (SELECT 1 FROM app.finalized_outcome_achievements AS used
                      WHERE used.school_id = outcome.school_id AND used.outcome_id = outcome.id)
           OR EXISTS (SELECT 1 FROM app.term_plan_week_outcomes AS used
                      WHERE used.school_id = outcome.school_id AND used.outcome_id = outcome.id)
           OR EXISTS (SELECT 1 FROM app.lesson_plan_outcomes AS used
                      WHERE used.school_id = outcome.school_id AND used.outcome_id = outcome.id)
         ) AS in_use,
         outcome.created_at, outcome.updated_at
  FROM app.learning_outcomes AS outcome
  JOIN app.subjects AS subject
    ON subject.id = outcome.subject_id AND subject.school_id = outcome.school_id
  JOIN app.grade_levels AS grade
    ON grade.id = outcome.grade_level_id AND grade.school_id = outcome.school_id
`;

type OutcomeRow = Omit<LearningOutcome, "created_at" | "updated_at"> & {
  created_at: Date;
  updated_at: Date;
};

const toOutcome = (row: OutcomeRow): LearningOutcome => ({
  ...row,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export async function listLearningOutcomes(
  tx: TransactionSql,
  schoolId: string,
  filter: { subjectId?: string; gradeLevelId?: string; includeArchived?: boolean },
): Promise<LearningOutcome[]> {
  const rows = await tx<OutcomeRow[]>`
    ${OUTCOME_SELECT(tx)}
    WHERE outcome.school_id = ${schoolId}::uuid
      ${filter.subjectId ? tx`AND outcome.subject_id = ${filter.subjectId}::uuid` : tx``}
      ${filter.gradeLevelId ? tx`AND outcome.grade_level_id = ${filter.gradeLevelId}::uuid` : tx``}
      ${filter.includeArchived ? tx`` : tx`AND outcome.archived_at IS NULL`}
    ORDER BY subject.name, grade.sort_order, grade.name, outcome.sort_order, outcome.code
  `;
  return rows.map(toOutcome);
}

async function requireOutcome(
  tx: TransactionSql,
  schoolId: string,
  outcomeId: string,
): Promise<LearningOutcome> {
  const [row] = await tx<OutcomeRow[]>`
    ${OUTCOME_SELECT(tx)}
    WHERE outcome.school_id = ${schoolId}::uuid AND outcome.id = ${outcomeId}::uuid
  `;
  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Learning outcome not found");
  }
  return toOutcome(row);
}

async function assertSubjectAndGrade(
  tx: TransactionSql,
  schoolId: string,
  subjectId: string,
  gradeLevelId: string,
): Promise<void> {
  const [row] = await tx<{ subject: boolean; grade: boolean }[]>`
    SELECT
      EXISTS (SELECT 1 FROM app.subjects
              WHERE id = ${subjectId}::uuid AND school_id = ${schoolId}::uuid) AS subject,
      EXISTS (SELECT 1 FROM app.grade_levels
              WHERE id = ${gradeLevelId}::uuid AND school_id = ${schoolId}::uuid) AS grade
  `;
  if (!row?.subject) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Subject not found");
  }
  if (!row.grade) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Grade level not found");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

function duplicate(code: string): never {
  throw new CodedHttpException(
    409,
    ERROR_CODES.LEARNING_OUTCOME_DUPLICATE,
    `An outcome with code "${code}" already exists for this subject and grade`,
  );
}

export interface LearningOutcomeInput {
  subject_id: string;
  grade_level_id: string;
  code: string;
  text: string;
  text_ar?: string | null;
  strand?: string | null;
  sort_order?: number;
}

export async function createLearningOutcome(
  tx: TransactionSql,
  schoolId: string,
  input: LearningOutcomeInput,
): Promise<LearningOutcome> {
  await assertSubjectAndGrade(tx, schoolId, input.subject_id, input.grade_level_id);
  const code = clean(input.code) ?? invalid("The code is required");
  const text = clean(input.text) ?? invalid("The text is required");
  let id: string;
  try {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.learning_outcomes (
        school_id, subject_id, grade_level_id, code, text, text_ar, strand, sort_order
      ) VALUES (
        ${schoolId}::uuid, ${input.subject_id}::uuid, ${input.grade_level_id}::uuid, ${code},
        ${text}, ${clean(input.text_ar)}, ${clean(input.strand)}, ${input.sort_order ?? 0}
      )
      RETURNING id
    `;
    id = row!.id;
  } catch (error) {
    if (isUniqueViolation(error)) duplicate(code);
    throw error;
  }
  const outcome = await requireOutcome(tx, schoolId, id);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "learning_outcomes",
    targetId: id,
    newValues: { ...outcome },
  });
  return outcome;
}

export interface LearningOutcomeUpdate {
  code?: string;
  text?: string;
  text_ar?: string | null;
  strand?: string | null;
  sort_order?: number;
  archived?: boolean;
}

export async function updateLearningOutcome(
  tx: TransactionSql,
  schoolId: string,
  outcomeId: string,
  input: LearningOutcomeUpdate,
): Promise<LearningOutcome> {
  const before = await requireOutcome(tx, schoolId, outcomeId);
  const code =
    input.code === undefined ? before.code : (clean(input.code) ?? invalid("The code is required"));
  const text =
    input.text === undefined ? before.text : (clean(input.text) ?? invalid("The text is required"));
  const textAr = input.text_ar === undefined ? before.text_ar : clean(input.text_ar);
  const strand = input.strand === undefined ? before.strand : clean(input.strand);
  const archived = input.archived ?? before.archived;
  try {
    await tx`
      UPDATE app.learning_outcomes
      SET code = ${code}, text = ${text}, text_ar = ${textAr}, strand = ${strand},
          sort_order = ${input.sort_order ?? before.sort_order},
          archived_at = CASE
            WHEN ${archived} THEN coalesce(archived_at, CURRENT_TIMESTAMP)
            ELSE NULL
          END,
          updated_at = GREATEST(CURRENT_TIMESTAMP, created_at)
      WHERE id = ${outcomeId}::uuid AND school_id = ${schoolId}::uuid
    `;
  } catch (error) {
    if (isUniqueViolation(error)) duplicate(code);
    throw error;
  }
  const after = await requireOutcome(tx, schoolId, outcomeId);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "learning_outcomes",
    targetId: outcomeId,
    oldValues: { ...before },
    newValues: { ...after },
  });
  return after;
}

export async function deleteLearningOutcome(
  tx: TransactionSql,
  schoolId: string,
  outcomeId: string,
): Promise<void> {
  const before = await requireOutcome(tx, schoolId, outcomeId);
  if (before.in_use) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.LEARNING_OUTCOME_IN_USE,
      "This outcome is used by achievement or plans; archive it instead",
    );
  }
  await tx`
    DELETE FROM app.learning_outcomes
    WHERE id = ${outcomeId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "learning_outcomes",
    targetId: outcomeId,
    oldValues: { ...before },
  });
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

export interface OutcomeImportResult {
  /** False when any row has an error, or on a dry run: nothing was written. */
  applied: boolean;
  created: number;
  updated: number;
  unchanged: number;
  errors: { line: number; message: string }[];
}

type ImportColumn = "subject" | "grade" | "code" | "text" | "text_ar" | "strand" | "sort_order";

const HEADER_ALIASES = new Map<ImportColumn, readonly string[]>([
  ["subject", ["subject", "subject_code", "subject code"]],
  ["grade", ["grade", "grade_level", "grade level"]],
  ["code", ["code", "outcome_code", "outcome code"]],
  ["text", ["text", "text_en", "outcome", "description"]],
  ["text_ar", ["text_ar", "arabic", "text (arabic)"]],
  ["strand", ["strand"]],
  ["sort_order", ["sort_order", "order"]],
]);

/**
 * Import outcomes from CSV (header row, then one outcome per row): subject (code), grade (grade
 * level name), code, text, and optionally text_ar, strand and sort_order. A row whose subject,
 * grade and code already exist updates that outcome. All or nothing: when any row has an error,
 * nothing is written and every error is reported with its line.
 */
export async function importLearningOutcomes(
  tx: TransactionSql,
  schoolId: string,
  input: { csv: string; dry_run: boolean },
): Promise<OutcomeImportResult> {
  const records = parseCsv(input.csv);
  if (records.length < 2) invalid("The file needs a header row and at least one outcome");
  if (records.length - 1 > OUTCOME_IMPORT_ROWS_MAX) {
    invalid(`At most ${OUTCOME_IMPORT_ROWS_MAX} outcomes can be imported at once`);
  }
  const header = records[0]!.cells.map((cell) => cell.trim().toLowerCase());
  const columns = new Map(
    [...HEADER_ALIASES].map(([key, aliases]) => [
      key,
      header.findIndex((name) => aliases.includes(name)),
    ]),
  );
  const missing = (["subject", "grade", "code", "text"] as const).filter(
    (key) => (columns.get(key) ?? -1) < 0,
  );
  if (missing.length > 0) invalid(`Missing column(s): ${missing.join(", ")}`);

  const subjects = await tx<{ id: string; code: string }[]>`
    SELECT id, code FROM app.subjects WHERE school_id = ${schoolId}::uuid
  `;
  const grades = await tx<{ id: string; name: string }[]>`
    SELECT id, name FROM app.grade_levels WHERE school_id = ${schoolId}::uuid
  `;
  const subjectByCode = new Map(subjects.map((row) => [row.code.trim().toLowerCase(), row.id]));
  const gradeByName = new Map(grades.map((row) => [row.name.trim().toLowerCase(), row.id]));
  const existing = await tx<
    {
      id: string;
      subject_id: string;
      grade_level_id: string;
      code: string;
      text: string;
      text_ar: string | null;
      strand: string | null;
      sort_order: number;
    }[]
  >`
    SELECT id, subject_id, grade_level_id, code, text, text_ar, strand, sort_order
    FROM app.learning_outcomes WHERE school_id = ${schoolId}::uuid
  `;
  const key = (subjectId: string, gradeId: string, code: string) =>
    `${subjectId}|${gradeId}|${code}`;
  const byKey = new Map(
    existing.map((row) => [key(row.subject_id, row.grade_level_id, row.code), row]),
  );

  // The highest sort order per subject and grade, so new outcomes without one go last.
  const lastOrder = new Map<string, number>();
  for (const row of existing) {
    const group = `${row.subject_id}|${row.grade_level_id}`;
    lastOrder.set(group, Math.max(lastOrder.get(group) ?? -1, row.sort_order));
  }
  const errors: OutcomeImportResult["errors"] = [];
  const planned: {
    existingId: string | null;
    subject_id: string;
    grade_level_id: string;
    code: string;
    text: string;
    text_ar: string | null;
    strand: string | null;
    sort_order: number;
  }[] = [];
  const seen = new Set<string>();
  let unchanged = 0;
  for (const record of records.slice(1)) {
    const cell = (name: ImportColumn) => {
      const index = columns.get(name) ?? -1;
      return index >= 0 ? clean(record.cells.at(index)) : null;
    };
    const problems: string[] = [];
    const subjectCode = cell("subject");
    const gradeName = cell("grade");
    const code = cell("code");
    const text = cell("text");
    const textAr = cell("text_ar");
    const strand = cell("strand");
    const sortText = cell("sort_order");
    const subjectId = subjectCode ? subjectByCode.get(subjectCode.toLowerCase()) : undefined;
    const gradeId = gradeName ? gradeByName.get(gradeName.toLowerCase()) : undefined;
    if (!subjectCode) problems.push("subject is missing");
    else if (!subjectId) problems.push(`no subject with code "${subjectCode}"`);
    if (!gradeName) problems.push("grade is missing");
    else if (!gradeId) problems.push(`no grade level named "${gradeName}"`);
    if (!code) problems.push("code is missing");
    else if (code.length > OUTCOME_CODE_MAX)
      problems.push(`code is longer than ${OUTCOME_CODE_MAX}`);
    if (!text) problems.push("text is missing");
    else if (text.length > OUTCOME_TEXT_MAX)
      problems.push(`text is longer than ${OUTCOME_TEXT_MAX}`);
    if (textAr && textAr.length > OUTCOME_TEXT_MAX) {
      problems.push(`text_ar is longer than ${OUTCOME_TEXT_MAX}`);
    }
    if (strand && strand.length > OUTCOME_STRAND_MAX) {
      problems.push(`strand is longer than ${OUTCOME_STRAND_MAX}`);
    }
    // Without a sort_order, an existing outcome keeps its place and a new one goes last.
    const sortOrder = sortText === null ? null : Number(sortText);
    if (
      sortOrder !== null &&
      (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000)
    ) {
      problems.push("sort_order must be a whole number from 0");
    }
    if (problems.length > 0 || !subjectId || !gradeId || !code || !text) {
      errors.push({ line: record.line, message: problems.join("; ") });
      continue;
    }
    const rowKey = key(subjectId, gradeId, code);
    if (seen.has(rowKey)) {
      errors.push({
        line: record.line,
        message: `code "${code}" appears twice for this subject and grade`,
      });
      continue;
    }
    seen.add(rowKey);
    const current = byKey.get(rowKey);
    const groupKey = `${subjectId}|${gradeId}`;
    const nextOrder = (): number => {
      const next = (lastOrder.get(groupKey) ?? -1) + 1;
      lastOrder.set(groupKey, next);
      return next;
    };
    const order = sortOrder ?? current?.sort_order ?? nextOrder();
    if (
      current &&
      current.text === text &&
      current.text_ar === textAr &&
      current.strand === strand &&
      current.sort_order === order
    ) {
      unchanged += 1;
      continue;
    }
    planned.push({
      existingId: current?.id ?? null,
      subject_id: subjectId,
      grade_level_id: gradeId,
      code,
      text,
      text_ar: textAr,
      strand,
      sort_order: order,
    });
  }

  const created = planned.filter((row) => row.existingId === null).length;
  const updated = planned.length - created;
  if (errors.length > 0 || input.dry_run) {
    return { applied: false, created, updated, unchanged, errors };
  }
  for (const row of planned) {
    if (row.existingId) {
      await tx`
        UPDATE app.learning_outcomes
        SET text = ${row.text}, text_ar = ${row.text_ar}, strand = ${row.strand},
            sort_order = ${row.sort_order}, updated_at = GREATEST(CURRENT_TIMESTAMP, created_at)
        WHERE id = ${row.existingId}::uuid AND school_id = ${schoolId}::uuid
      `;
    } else {
      await tx`
        INSERT INTO app.learning_outcomes (
          school_id, subject_id, grade_level_id, code, text, text_ar, strand, sort_order
        ) VALUES (
          ${schoolId}::uuid, ${row.subject_id}::uuid, ${row.grade_level_id}::uuid, ${row.code},
          ${row.text}, ${row.text_ar}, ${row.strand}, ${row.sort_order}
        )
      `;
    }
  }
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "learning_outcomes",
    targetId: schoolId,
    newValues: { imported: { created, updated, unchanged } },
  });
  return { applied: true, created, updated, unchanged, errors };
}

// ---------------------------------------------------------------------------
// Achievement: one section, subject and period
// ---------------------------------------------------------------------------

export interface SectionOutcomeAchievementView {
  section_id: string;
  section_name: string;
  grade_level_id: string;
  grade_level_name: string;
  academic_year_id: string;
  subject_id: string;
  subject_name: string;
  term_id: string | null;
  access: SectionSubjectAccess;
  /** The teacher may save: not a coordinator, the year is active and the period not finalized. */
  editable: boolean;
  finalized: boolean;
  show_on_report_cards: boolean;
  levels: AchievementLevel[];
  terms: { term_id: string; term_name: string }[];
  outcomes: {
    id: string;
    code: string;
    text: string;
    text_ar: string | null;
    strand: string | null;
    archived: boolean;
  }[];
  students: {
    student_id: string;
    first_name: string;
    last_name: string;
    admission_number: string;
    achievements: { outcome_id: string; level: number }[];
  }[];
}

async function loadSheet(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
  termId: string | null,
) {
  const section = await requireSectionRow(tx, schoolId, sectionId);
  const subject = await requireEffectiveSubject(tx, schoolId, section, subjectId);
  const terms = await loadYearTerms(tx, schoolId, section.academic_year_id);
  if (termId !== null && !terms.some((term) => term.id === termId)) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Term not found");
  }
  const year = await requireYear(tx, schoolId, section.academic_year_id);
  const [finalized] = await tx<{ id: string }[]>`
    SELECT id FROM app.result_finalizations
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
      AND term_id IS NOT DISTINCT FROM ${termId}::uuid AND status = 'finalized'
  `;
  const roster = (await loadRoster(tx, schoolId, section, subjectId, subject.requirement)).filter(
    (student) => student.status === "enrolled",
  );
  return { section, subject, terms, year, finalized: finalized !== undefined, roster };
}

export async function getSectionOutcomeAchievements(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  subjectId: string,
  termId: string | null,
): Promise<SectionOutcomeAchievementView> {
  const { access } = await assertCanReadSectionSubject(tx, sectionId, subjectId);
  const sheet = await loadSheet(tx, schoolId, sectionId, subjectId, termId);
  const settings = await getPlanningSettings(tx, schoolId);
  const studentIds = sheet.roster.map((student) => student.student_id);
  const rows = studentIds.length
    ? await tx<{ student_id: string; outcome_id: string; level: number }[]>`
        SELECT student_id, outcome_id, level
        FROM app.student_outcome_achievements
        WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
          AND subject_id = ${subjectId}::uuid AND term_id IS NOT DISTINCT FROM ${termId}::uuid
          AND student_id = ANY (${studentIds}::uuid[])
      `
    : [];
  const used = new Set(rows.map((row) => row.outcome_id));
  // The grade's active outcomes, and archived ones still holding a level in this sheet.
  const outcomes = (
    await tx<SectionOutcomeAchievementView["outcomes"][number][]>`
      SELECT id, code, text, text_ar, strand, archived_at IS NOT NULL AS archived
      FROM app.learning_outcomes
      WHERE school_id = ${schoolId}::uuid AND subject_id = ${subjectId}::uuid
        AND grade_level_id = ${sheet.section.grade_level_id}::uuid
      ORDER BY sort_order, code
    `
  ).filter((outcome) => !outcome.archived || used.has(outcome.id));
  const byStudent = new Map<string, { outcome_id: string; level: number }[]>();
  for (const row of rows) {
    const list = byStudent.get(row.student_id) ?? [];
    list.push({ outcome_id: row.outcome_id, level: row.level });
    byStudent.set(row.student_id, list);
  }
  return {
    section_id: sheet.section.id,
    section_name: sheet.section.name,
    grade_level_id: sheet.section.grade_level_id,
    grade_level_name: sheet.section.grade_level_name,
    academic_year_id: sheet.section.academic_year_id,
    subject_id: subjectId,
    subject_name: sheet.subject.subject_name,
    term_id: termId,
    access,
    editable:
      access !== "coordinator" && !sheet.finalized && sheet.year.grading_config_status === "active",
    finalized: sheet.finalized,
    show_on_report_cards: settings.show_outcomes_on_report_cards,
    levels: settings.achievement_levels,
    terms: sheet.terms.map((term) => ({ term_id: term.id, term_name: term.name })),
    outcomes,
    students: sheet.roster.map((student) => ({
      student_id: student.student_id,
      first_name: student.first_name,
      last_name: student.last_name,
      admission_number: student.admission_number,
      achievements: byStudent.get(student.student_id) ?? [],
    })),
  };
}

export interface OutcomeAchievementInput {
  student_id: string;
  outcome_id: string;
  /** null: the level is removed. */
  level: number | null;
}

export async function saveSectionOutcomeAchievements(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sectionId: string,
  subjectId: string,
  termId: string | null,
  items: readonly OutcomeAchievementInput[],
): Promise<{ saved: number; cleared: number }> {
  await assertCanGradeSectionSubject(tx, sectionId, subjectId);
  const sheet = await loadSheet(tx, schoolId, sectionId, subjectId, termId);
  if (sheet.finalized) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RESULTS_ALREADY_FINALIZED,
      "These results are already finalized, so outcome achievement can no longer change",
    );
  }
  if (sheet.year.grading_config_status !== "active") {
    throw new CodedHttpException(
      409,
      sheet.year.grading_config_status === "draft"
        ? ERROR_CODES.ACADEMIC_YEAR_NOT_ACTIVE
        : ERROR_CODES.ACADEMIC_CONFIG_LOCKED,
      sheet.year.grading_config_status === "draft"
        ? "Publish the year's grading configuration before recording outcome achievement"
        : "This year's results are closed; outcome achievement is read-only",
    );
  }
  const pairs = items.map((item) => `${item.student_id}|${item.outcome_id}`);
  if (new Set(pairs).size !== pairs.length) {
    invalid("Each student and outcome may appear only once");
  }
  const roster = new Set(sheet.roster.map((student) => student.student_id));
  const outside = items.filter((item) => !roster.has(item.student_id));
  if (outside.length > 0) {
    invalid(
      `Not taking this subject in this section: ${outside
        .slice(0, 5)
        .map((item) => item.student_id)
        .join(", ")}`,
    );
  }
  const outcomes = await tx<{ id: string; archived: boolean }[]>`
    SELECT id, archived_at IS NOT NULL AS archived FROM app.learning_outcomes
    WHERE school_id = ${schoolId}::uuid AND subject_id = ${subjectId}::uuid
      AND grade_level_id = ${sheet.section.grade_level_id}::uuid
  `;
  const known = new Map(outcomes.map((outcome) => [outcome.id, outcome.archived]));
  const settings = await getPlanningSettings(tx, schoolId);
  const levels = new Set(settings.achievement_levels.map((level) => level.level));
  for (const item of items) {
    if (!known.has(item.outcome_id)) {
      invalid(`Not an outcome of this subject and grade: ${item.outcome_id}`);
    }
    if (item.level !== null) {
      if (known.get(item.outcome_id)) invalid("An archived outcome can only be cleared");
      if (!levels.has(item.level)) invalid(`Level ${item.level} is not on the school's scale`);
    }
  }

  // Serialize writers to this sheet so two saves of one student update one row.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`outcome-achievements:${sectionId}:${subjectId}:${termId ?? "annual"}`}, 0))`;
  const studentIds = [...new Set(items.map((item) => item.student_id))];
  const previous = studentIds.length
    ? await tx<{ student_id: string; outcome_id: string; level: number }[]>`
        SELECT student_id, outcome_id, level FROM app.student_outcome_achievements
        WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
          AND subject_id = ${subjectId}::uuid AND term_id IS NOT DISTINCT FROM ${termId}::uuid
          AND student_id = ANY (${studentIds}::uuid[])
      `
    : [];
  const before = new Map(previous.map((row) => [`${row.student_id}|${row.outcome_id}`, row.level]));

  let saved = 0;
  let cleared = 0;
  const changes = new Map<string, { from: number | null; to: number | null }>();
  for (const item of items) {
    const pair = `${item.student_id}|${item.outcome_id}`;
    const old = before.get(pair) ?? null;
    if (old === item.level) continue;
    changes.set(pair, { from: old, to: item.level });
    if (item.level === null) {
      const removed = await tx`
        DELETE FROM app.student_outcome_achievements
        WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
          AND term_id IS NOT DISTINCT FROM ${termId}::uuid
          AND student_id = ${item.student_id}::uuid AND outcome_id = ${item.outcome_id}::uuid
      `;
      cleared += removed.count;
      continue;
    }
    if (old !== null) {
      await tx`
        UPDATE app.student_outcome_achievements
        SET level = ${item.level}, entered_by_user_id = ${userId}::uuid,
            updated_at = GREATEST(CURRENT_TIMESTAMP, created_at)
        WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
          AND term_id IS NOT DISTINCT FROM ${termId}::uuid
          AND student_id = ${item.student_id}::uuid AND outcome_id = ${item.outcome_id}::uuid
      `;
    } else {
      await tx`
        INSERT INTO app.student_outcome_achievements (
          school_id, academic_year_id, section_id, term_id, student_id, subject_id, outcome_id,
          level, entered_by_user_id
        ) VALUES (
          ${schoolId}::uuid, ${sheet.section.academic_year_id}::uuid, ${sectionId}::uuid,
          ${termId}::uuid, ${item.student_id}::uuid, ${subjectId}::uuid, ${item.outcome_id}::uuid,
          ${item.level}, ${userId}::uuid
        )
      `;
    }
    saved += 1;
  }
  if (changes.size > 0) {
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "student_outcome_achievements",
      targetId: sectionId,
      oldValues: { subject_id: subjectId, term_id: termId },
      newValues: { subject_id: subjectId, term_id: termId, changes: Object.fromEntries(changes) },
    });
  }
  return { saved, cleared };
}
