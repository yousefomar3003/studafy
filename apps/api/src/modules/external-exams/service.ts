import { ERROR_CODES } from "@studafy/constants";
import {
  EXTERNAL_EXAM_PRESETS,
  computeExternalExamTotal,
  externalExamPreset,
  validateExternalExamDefinition,
  validateExternalExamScore,
} from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type {
  ExternalExamComponentDefinition,
  ExternalExamDefinition,
  ExternalExamPreset,
  ExternalExamPresetKey,
  ExternalExamScoreType,
  ExternalExamTotalMode,
  ValidationIssue,
} from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * External exams and test scores (000255): a school's catalogue of external exams (SAT, IELTS,
 * IGCSE finals...) and each student's results in them.
 *
 * School leadership manages the catalogue and records results; the routes gate that on
 * academicConfig:manage. Results are read by whoever may read the student (app.can_read_student:
 * leadership, the student's teachers, the student, linked parents); RLS enforces the same rule.
 *
 * Every score is validated against its component, and the total is worked out here from the scores
 * (@studafy/grading-engine), never taken from the client. Once an exam has results, the rules
 * those results were scored and totalled by are locked; names, codes, ranges shown beside the total
 * and transcript visibility stay editable.
 */

// ---------------------------------------------------------------------------
// Views and inputs
// ---------------------------------------------------------------------------

export interface ExternalExamComponentView {
  id: string;
  name: string;
  score_type: ExternalExamScoreType;
  min_score: number | null;
  max_score: number | null;
  step: number | null;
  allowed_labels: string[] | null;
  sort_order: number;
  /** Results have scores in it: its scoring rules are locked and it cannot be removed. */
  has_scores: boolean;
}

export interface ExternalExamView {
  id: string;
  code: string;
  name: string;
  preset_key: string | null;
  total_mode: ExternalExamTotalMode;
  total_rounding_step: number | null;
  total_min: number | null;
  total_max: number | null;
  per_subject: boolean;
  show_on_transcript: boolean;
  archived_at: string | null;
  result_count: number;
  components: ExternalExamComponentView[];
  created_at: string;
  updated_at: string;
}

export interface ExternalExamComponentInput {
  /** An existing component of the exam (update only); absent for a new one. */
  id?: string | undefined;
  name: string;
  score_type: ExternalExamScoreType;
  min_score?: number | null | undefined;
  max_score?: number | null | undefined;
  step?: number | null | undefined;
  allowed_labels?: string[] | null | undefined;
}

export interface ExternalExamInput {
  code: string;
  name: string;
  total_mode: ExternalExamTotalMode;
  total_rounding_step?: number | null | undefined;
  total_min?: number | null | undefined;
  total_max?: number | null | undefined;
  per_subject: boolean;
  show_on_transcript: boolean;
  /** In display order. */
  components: ExternalExamComponentInput[];
}

export interface ExternalExamScoreInput {
  component_id: string;
  numeric_score?: number | null | undefined;
  label_score?: string | null | undefined;
}

export interface ExternalExamResultInput {
  subject_id?: string | null | undefined;
  /** The exam entry (000262) the result came from; on update, absent keeps the current one. */
  entry_id?: string | null | undefined;
  sat_on: string;
  note?: string | null | undefined;
  scores: ExternalExamScoreInput[];
}

export interface ExternalExamScoreView {
  component_id: string;
  component_name: string;
  score_type: ExternalExamScoreType;
  numeric_score: number | null;
  label_score: string | null;
  max_score: number | null;
}

export interface ExternalExamResultView {
  id: string;
  student_id: string;
  exam: {
    id: string;
    code: string;
    name: string;
    total_mode: ExternalExamTotalMode;
    total_min: number | null;
    total_max: number | null;
    per_subject: boolean;
    archived: boolean;
  };
  subject: { id: string; code: string; name: string } | null;
  entry_id: string | null;
  sat_on: string;
  total_score: number | null;
  note: string | null;
  scores: ExternalExamScoreView[];
  recorded_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface ExternalExamPresetView {
  key: ExternalExamPresetKey;
  code: string;
  name: string;
  total_mode: ExternalExamTotalMode;
  total_rounding_step: number | null;
  total_min: number | null;
  total_max: number | null;
  per_subject: boolean;
  show_on_transcript: boolean;
  note: string | null;
  components: {
    name: string;
    score_type: ExternalExamScoreType;
    min_score: number | null;
    max_score: number | null;
    step: number | null;
    allowed_labels: string[] | null;
  }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const num = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

function invalid(issues: readonly ValidationIssue[]): never {
  throw new CodedHttpException(
    400,
    ERROR_CODES.VALIDATION_FAILED,
    issues.map((issue) => issue.message).join(" "),
  );
}

function conflict(message: string): never {
  throw new CodedHttpException(409, ERROR_CODES.CONFLICT_STATE_MISMATCH, message);
}

function notFound(message: string): never {
  throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, message);
}

function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === code;
}

function componentDefinition(input: ExternalExamComponentInput): ExternalExamComponentDefinition {
  const numeric = input.score_type === "numeric";
  return {
    name: input.name,
    scoreType: input.score_type,
    minScore: numeric ? (input.min_score ?? null) : null,
    maxScore: numeric ? (input.max_score ?? null) : null,
    step: numeric ? (input.step ?? null) : null,
    allowedLabels: numeric ? null : (input.allowed_labels ?? null),
  };
}

function definitionOf(input: ExternalExamInput): ExternalExamDefinition {
  const withTotal = input.total_mode !== "none";
  return {
    code: input.code,
    name: input.name,
    totalMode: input.total_mode,
    totalRoundingStep: input.total_mode === "average" ? (input.total_rounding_step ?? null) : null,
    totalMin: withTotal ? (input.total_min ?? null) : null,
    totalMax: withTotal ? (input.total_max ?? null) : null,
    perSubject: input.per_subject,
    showOnTranscript: input.show_on_transcript,
    components: input.components.map(componentDefinition),
  };
}

function presetView(preset: ExternalExamPreset): ExternalExamPresetView {
  return {
    key: preset.key,
    code: preset.code,
    name: preset.name,
    total_mode: preset.totalMode,
    total_rounding_step: preset.totalRoundingStep,
    total_min: preset.totalMin,
    total_max: preset.totalMax,
    per_subject: preset.perSubject,
    show_on_transcript: preset.showOnTranscript,
    note: preset.note,
    components: preset.components.map((component) => ({
      name: component.name,
      score_type: component.scoreType,
      min_score: component.minScore,
      max_score: component.maxScore,
      step: component.step,
      allowed_labels: component.allowedLabels,
    })),
  };
}

export function listExternalExamPresets(): ExternalExamPresetView[] {
  return EXTERNAL_EXAM_PRESETS.map(presetView);
}

// ---------------------------------------------------------------------------
// Catalogue: reading
// ---------------------------------------------------------------------------

interface ExamRow {
  id: string;
  code: string;
  name: string;
  preset_key: string | null;
  total_mode: ExternalExamTotalMode;
  total_rounding_step: string | null;
  total_min: string | null;
  total_max: string | null;
  per_subject: boolean;
  show_on_transcript: boolean;
  archived_at: Date | null;
  result_count: number;
  created_at: Date;
  updated_at: Date;
}

interface ComponentRow {
  id: string;
  exam_id: string;
  name: string;
  score_type: ExternalExamScoreType;
  min_score: string | null;
  max_score: string | null;
  step: string | null;
  allowed_labels: string[] | null;
  sort_order: number;
  has_scores: boolean;
}

function toComponentView(row: ComponentRow): ExternalExamComponentView {
  return {
    id: row.id,
    name: row.name,
    score_type: row.score_type,
    min_score: num(row.min_score),
    max_score: num(row.max_score),
    step: num(row.step),
    allowed_labels: row.allowed_labels,
    sort_order: row.sort_order,
    has_scores: row.has_scores,
  };
}

function toComponentDefinition(row: ComponentRow): ExternalExamComponentDefinition {
  return {
    name: row.name,
    scoreType: row.score_type,
    minScore: num(row.min_score),
    maxScore: num(row.max_score),
    step: num(row.step),
    allowedLabels: row.allowed_labels,
  };
}

async function loadComponents(
  tx: TransactionSql,
  schoolId: string,
  examIds: readonly string[],
): Promise<ComponentRow[]> {
  if (examIds.length === 0) return [];
  return tx<ComponentRow[]>`
    SELECT component.id, component.exam_id, component.name, component.score_type,
           component.min_score::text AS min_score, component.max_score::text AS max_score,
           component.step::text AS step, component.allowed_labels, component.sort_order,
           EXISTS (
             SELECT 1 FROM app.student_external_exam_scores AS score
             WHERE score.component_id = component.id AND score.exam_id = component.exam_id
               AND score.school_id = component.school_id
           ) AS has_scores
    FROM app.external_exam_components AS component
    WHERE component.school_id = ${schoolId}::uuid
      AND component.exam_id = ANY (${examIds as string[]}::uuid[])
    ORDER BY component.exam_id, component.sort_order, component.name
  `;
}

const EXAM_COLUMNS = `
  exam.id, exam.code, exam.name, exam.preset_key, exam.total_mode,
  exam.total_rounding_step::text AS total_rounding_step, exam.total_min::text AS total_min,
  exam.total_max::text AS total_max, exam.per_subject, exam.show_on_transcript, exam.archived_at,
  (SELECT count(*)::int FROM app.student_external_exam_results AS result
   WHERE result.exam_id = exam.id AND result.school_id = exam.school_id) AS result_count,
  exam.created_at, exam.updated_at`;

function toExamView(row: ExamRow, components: readonly ComponentRow[]): ExternalExamView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    preset_key: row.preset_key,
    total_mode: row.total_mode,
    total_rounding_step: num(row.total_rounding_step),
    total_min: num(row.total_min),
    total_max: num(row.total_max),
    per_subject: row.per_subject,
    show_on_transcript: row.show_on_transcript,
    archived_at: row.archived_at?.toISOString() ?? null,
    result_count: row.result_count,
    components: components.filter((c) => c.exam_id === row.id).map(toComponentView),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function listExternalExams(
  tx: TransactionSql,
  schoolId: string,
  includeArchived: boolean,
): Promise<ExternalExamView[]> {
  const archivedClause = includeArchived ? tx`` : tx`AND exam.archived_at IS NULL`;
  const rows = await tx<ExamRow[]>`
    SELECT ${tx.unsafe(EXAM_COLUMNS)}
    FROM app.external_exams AS exam
    WHERE exam.school_id = ${schoolId}::uuid ${archivedClause}
    ORDER BY exam.archived_at IS NOT NULL, exam.name, exam.code
  `;
  const components = await loadComponents(
    tx,
    schoolId,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toExamView(row, components));
}

async function requireExamRow(
  tx: TransactionSql,
  schoolId: string,
  examId: string,
  lock = false,
): Promise<ExamRow> {
  const lockClause = lock ? tx`FOR UPDATE OF exam` : tx``;
  const [row] = await tx<ExamRow[]>`
    SELECT ${tx.unsafe(EXAM_COLUMNS)}
    FROM app.external_exams AS exam
    WHERE exam.id = ${examId}::uuid AND exam.school_id = ${schoolId}::uuid
    ${lockClause}
  `;
  if (!row) notFound("External exam not found");
  return row;
}

export async function getExternalExam(
  tx: TransactionSql,
  schoolId: string,
  examId: string,
): Promise<ExternalExamView> {
  const row = await requireExamRow(tx, schoolId, examId);
  return toExamView(row, await loadComponents(tx, schoolId, [examId]));
}

// ---------------------------------------------------------------------------
// Catalogue: writing
// ---------------------------------------------------------------------------

/** Insert the exam; a code already used in the school (any case) is a 409. */
async function insertExam(
  tx: TransactionSql,
  schoolId: string,
  definition: ExternalExamDefinition,
  presetKey: string | null,
): Promise<string> {
  try {
    const [row] = await tx.savepoint(
      (sp) => sp<{ id: string }[]>`
        INSERT INTO app.external_exams (
          school_id, code, name, preset_key, total_mode, total_rounding_step, total_min, total_max,
          per_subject, show_on_transcript
        )
        VALUES (
          ${schoolId}::uuid, ${definition.code}, ${definition.name}, ${presetKey},
          ${definition.totalMode}, ${definition.totalRoundingStep}, ${definition.totalMin},
          ${definition.totalMax}, ${definition.perSubject}, ${definition.showOnTranscript}
        )
        RETURNING id
      `,
    );
    return row!.id;
  } catch (error) {
    if (isPgError(error, "23505")) duplicateCode(definition.code);
    throw error;
  }
}

function duplicateCode(code: string): never {
  throw new CodedHttpException(
    409,
    ERROR_CODES.CONFLICT_DUPLICATE_ENTRY,
    `The school already has an external exam with the code "${code}"`,
  );
}

async function insertComponent(
  tx: TransactionSql,
  schoolId: string,
  examId: string,
  component: ExternalExamComponentDefinition,
  sortOrder: number,
): Promise<void> {
  await tx`
    INSERT INTO app.external_exam_components (
      school_id, exam_id, name, score_type, min_score, max_score, step, allowed_labels, sort_order
    )
    VALUES (
      ${schoolId}::uuid, ${examId}::uuid, ${component.name}, ${component.scoreType},
      ${component.minScore}, ${component.maxScore}, ${component.step},
      ${component.allowedLabels}::text[], ${sortOrder}
    )
  `;
}

async function createExam(
  tx: TransactionSql,
  schoolId: string,
  definition: ExternalExamDefinition,
  presetKey: string | null,
): Promise<ExternalExamView> {
  const issues = validateExternalExamDefinition(definition);
  if (issues.length > 0) invalid(issues);
  const examId = await insertExam(tx, schoolId, definition, presetKey);
  for (const [index, component] of definition.components.entries()) {
    await insertComponent(tx, schoolId, examId, component, index);
  }
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "external_exams",
    targetId: examId,
    newValues: {
      code: definition.code,
      name: definition.name,
      preset_key: presetKey,
      total_mode: definition.totalMode,
      per_subject: definition.perSubject,
      show_on_transcript: definition.showOnTranscript,
      components: definition.components.map((component) => component.name),
    },
  });
  return getExternalExam(tx, schoolId, examId);
}

export function createExternalExam(
  tx: TransactionSql,
  schoolId: string,
  input: ExternalExamInput,
): Promise<ExternalExamView> {
  return createExam(tx, schoolId, definitionOf(input), null);
}

/** Copy a built-in preset into the school's catalogue, optionally under another code or name. */
export function createExternalExamFromPreset(
  tx: TransactionSql,
  schoolId: string,
  input: { preset_key: string; code?: string | undefined; name?: string | undefined },
): Promise<ExternalExamView> {
  const preset = externalExamPreset(input.preset_key);
  if (!preset) notFound("Unknown external exam preset");
  return createExam(
    tx,
    schoolId,
    {
      ...preset,
      code: input.code ?? preset.code,
      name: input.name ?? preset.name,
      components: preset.components.map((component) => ({
        ...component,
        allowedLabels: component.allowedLabels ? [...component.allowedLabels] : null,
      })),
    },
    preset.key,
  );
}

function sameRule(a: ExternalExamComponentDefinition, b: ExternalExamComponentDefinition): boolean {
  return (
    a.scoreType === b.scoreType &&
    a.minScore === b.minScore &&
    a.maxScore === b.maxScore &&
    a.step === b.step &&
    JSON.stringify(a.allowedLabels) === JSON.stringify(b.allowedLabels)
  );
}

/**
 * Replace an exam's definition. Components are matched by id: listed ones are updated, new ones
 * (no id) added, missing ones removed. With results recorded, the total rule, per-subject setting
 * and a scored component's scoring rule cannot change, and a scored component cannot be removed.
 */
export async function updateExternalExam(
  tx: TransactionSql,
  schoolId: string,
  examId: string,
  input: ExternalExamInput,
): Promise<ExternalExamView> {
  const before = await requireExamRow(tx, schoolId, examId, true);
  const existing = await loadComponents(tx, schoolId, [examId]);
  const definition = definitionOf(input);
  const issues = validateExternalExamDefinition(definition);
  if (issues.length > 0) invalid(issues);

  const byId = new Map(existing.map((row) => [row.id, row]));
  const keptIds = new Set<string>();
  for (const component of input.components) {
    if (component.id === undefined) continue;
    if (!byId.has(component.id) || keptIds.has(component.id)) {
      invalid([
        {
          code: "COMPONENT_UNKNOWN",
          severity: "error",
          message: `Component ${component.id} is not part of this exam.`,
        },
      ]);
    }
    keptIds.add(component.id);
  }

  if (before.result_count > 0) {
    if (
      definition.totalMode !== before.total_mode ||
      definition.totalRoundingStep !== num(before.total_rounding_step) ||
      definition.perSubject !== before.per_subject
    ) {
      conflict(
        "Results have been recorded for this exam: its total and per-subject setting can no longer change",
      );
    }
    input.components.forEach((component, index) => {
      const row = component.id === undefined ? undefined : byId.get(component.id);
      if (row?.has_scores && !sameRule(toComponentDefinition(row), definition.components[index]!)) {
        conflict(`"${row.name}" has recorded scores: how it is scored can no longer change`);
      }
    });
  }
  const removed = existing.filter((row) => !keptIds.has(row.id));
  const scoredRemoval = removed.find((row) => row.has_scores);
  if (scoredRemoval) {
    conflict(`"${scoredRemoval.name}" has recorded scores and cannot be removed`);
  }

  try {
    await tx.savepoint(async (sp) => {
      await sp`
        UPDATE app.external_exams
        SET code = ${definition.code}, name = ${definition.name},
            total_mode = ${definition.totalMode},
            total_rounding_step = ${definition.totalRoundingStep},
            total_min = ${definition.totalMin}, total_max = ${definition.totalMax},
            per_subject = ${definition.perSubject},
            show_on_transcript = ${definition.showOnTranscript},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${examId}::uuid AND school_id = ${schoolId}::uuid
      `;
    });
  } catch (error) {
    if (isPgError(error, "23505")) duplicateCode(definition.code);
    throw error;
  }

  if (removed.length > 0) {
    await tx`
      DELETE FROM app.external_exam_components
      WHERE school_id = ${schoolId}::uuid AND exam_id = ${examId}::uuid
        AND id = ANY (${removed.map((row) => row.id)}::uuid[])
    `;
  }
  // Names are unique per exam: park the kept components under temporary names first, so two
  // components can swap names in one save.
  if (keptIds.size > 0) {
    await tx`
      UPDATE app.external_exam_components SET name = id::text
      WHERE school_id = ${schoolId}::uuid AND exam_id = ${examId}::uuid
        AND id = ANY (${[...keptIds]}::uuid[])
    `;
  }
  for (const [index, component] of input.components.entries()) {
    const rule = definition.components[index]!;
    if (component.id === undefined) {
      await insertComponent(tx, schoolId, examId, rule, index);
      continue;
    }
    await tx`
      UPDATE app.external_exam_components
      SET name = ${rule.name}, score_type = ${rule.scoreType}, min_score = ${rule.minScore},
          max_score = ${rule.maxScore}, step = ${rule.step},
          allowed_labels = ${rule.allowedLabels}::text[], sort_order = ${index},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${component.id}::uuid AND school_id = ${schoolId}::uuid
    `;
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "external_exams",
    targetId: examId,
    oldValues: {
      code: before.code,
      name: before.name,
      total_mode: before.total_mode,
      per_subject: before.per_subject,
      show_on_transcript: before.show_on_transcript,
      components: existing.map((row) => row.name),
    },
    newValues: {
      code: definition.code,
      name: definition.name,
      total_mode: definition.totalMode,
      per_subject: definition.perSubject,
      show_on_transcript: definition.showOnTranscript,
      components: definition.components.map((component) => component.name),
    },
  });
  return getExternalExam(tx, schoolId, examId);
}

/** Archive (hide from new results) or restore an exam. Its results are untouched either way. */
export async function setExternalExamArchived(
  tx: TransactionSql,
  schoolId: string,
  examId: string,
  archived: boolean,
): Promise<ExternalExamView> {
  const before = await requireExamRow(tx, schoolId, examId, true);
  if ((before.archived_at !== null) !== archived) {
    await tx`
      UPDATE app.external_exams
      SET archived_at = ${archived ? tx`CURRENT_TIMESTAMP` : null}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${examId}::uuid AND school_id = ${schoolId}::uuid
    `;
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "external_exams",
      targetId: examId,
      oldValues: { archived: before.archived_at !== null },
      newValues: { archived },
    });
  }
  return getExternalExam(tx, schoolId, examId);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Leadership, the student's teachers, the student, or a linked parent (as RLS has it). */
export async function assertCanReadStudent(tx: TransactionSql, studentId: string): Promise<void> {
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT app.can_read_student(${studentId}::uuid) AS allowed
  `;
  if (!row?.allowed) throw new CodedHttpException(403, ERROR_CODES.ACCESS_DENIED, "Access denied");
}

async function requireStudent(tx: TransactionSql, schoolId: string, studentId: string) {
  const [student] = await tx<{ id: string }[]>`
    SELECT id FROM app.students WHERE id = ${studentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!student) notFound("Student not found");
}

interface ResultRow {
  id: string;
  student_id: string;
  exam_id: string;
  exam_code: string;
  exam_name: string;
  total_mode: ExternalExamTotalMode;
  total_min: string | null;
  total_max: string | null;
  per_subject: boolean;
  archived_at: Date | null;
  subject_id: string | null;
  entry_id: string | null;
  sat_on: string;
  total_score: string | null;
  note: string | null;
  recorded_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

interface ScoreRow {
  result_id: string;
  component_id: string;
  component_name: string;
  score_type: ExternalExamScoreType;
  numeric_score: string | null;
  label_score: string | null;
  max_score: string | null;
  sort_order: number;
}

async function loadResults(
  tx: TransactionSql,
  schoolId: string,
  filter: { studentId: string } | { resultId: string },
): Promise<ExternalExamResultView[]> {
  const where =
    "studentId" in filter
      ? tx`result.student_id = ${filter.studentId}::uuid`
      : tx`result.id = ${filter.resultId}::uuid`;
  const rows = await tx<ResultRow[]>`
    SELECT result.id, result.student_id, result.exam_id, exam.code AS exam_code,
           exam.name AS exam_name, exam.total_mode, exam.total_min::text AS total_min,
           exam.total_max::text AS total_max, exam.per_subject, exam.archived_at, result.subject_id,
           result.entry_id, result.sat_on::text AS sat_on, result.total_score::text AS total_score, result.note,
           result.recorded_by_user_id, result.created_at, result.updated_at
    FROM app.student_external_exam_results AS result
    JOIN app.external_exams AS exam
      ON exam.id = result.exam_id AND exam.school_id = result.school_id
    WHERE result.school_id = ${schoolId}::uuid AND ${where}
    ORDER BY result.sat_on DESC, exam.name, result.created_at DESC
  `;
  if (rows.length === 0) return [];
  const resultIds = rows.map((row) => row.id);
  const scores = await tx<ScoreRow[]>`
    SELECT score.result_id, score.component_id, component.name AS component_name,
           component.score_type, score.numeric_score::text AS numeric_score, score.label_score,
           component.max_score::text AS max_score, component.sort_order
    FROM app.student_external_exam_scores AS score
    JOIN app.external_exam_components AS component
      ON component.id = score.component_id AND component.school_id = score.school_id
    WHERE score.school_id = ${schoolId}::uuid AND score.result_id = ANY (${resultIds}::uuid[])
    ORDER BY component.sort_order, component.name
  `;
  // Subjects through app.external_exam_result_subjects: app.subjects' role scope would hide a
  // subject the student takes no class in from the student and their parents (000255).
  const studentIds = [...new Set(rows.map((row) => row.student_id))];
  const subjects = new Map<string, { id: string; code: string; name: string }>();
  for (const studentId of studentIds) {
    const found = await tx<{ subject_id: string; code: string; name: string }[]>`
      SELECT subject_id, code, name FROM app.external_exam_result_subjects(${studentId}::uuid)
    `;
    for (const subject of found) {
      subjects.set(subject.subject_id, {
        id: subject.subject_id,
        code: subject.code,
        name: subject.name,
      });
    }
  }
  return rows.map((row) => ({
    id: row.id,
    student_id: row.student_id,
    exam: {
      id: row.exam_id,
      code: row.exam_code,
      name: row.exam_name,
      total_mode: row.total_mode,
      total_min: num(row.total_min),
      total_max: num(row.total_max),
      per_subject: row.per_subject,
      archived: row.archived_at !== null,
    },
    subject: row.subject_id === null ? null : (subjects.get(row.subject_id) ?? null),
    entry_id: row.entry_id,
    sat_on: row.sat_on,
    total_score: num(row.total_score),
    note: row.note,
    scores: scores
      .filter((score) => score.result_id === row.id)
      .map((score) => ({
        component_id: score.component_id,
        component_name: score.component_name,
        score_type: score.score_type,
        numeric_score: num(score.numeric_score),
        label_score: score.label_score,
        max_score: num(score.max_score),
      })),
    recorded_by_user_id: row.recorded_by_user_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
}

/** Every external exam result of a student, newest sitting first. */
export async function listStudentExternalExamResults(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<ExternalExamResultView[]> {
  await assertCanReadStudent(tx, studentId);
  // Leadership of another school passes the role check; the student is not in their school.
  await requireStudent(tx, schoolId, studentId);
  return loadResults(tx, schoolId, { studentId });
}

async function getResult(
  tx: TransactionSql,
  schoolId: string,
  resultId: string,
): Promise<ExternalExamResultView> {
  const [result] = await loadResults(tx, schoolId, { resultId });
  if (!result) notFound("External exam result not found");
  return result;
}

interface CheckedScore {
  componentId: string;
  numeric: number | null;
  label: string | null;
}

/**
 * Validate a result against its exam: the subject rule, each score against its component, and the
 * total worked out from the scores in component order.
 */
async function checkResult(
  tx: TransactionSql,
  schoolId: string,
  exam: ExamRow,
  input: ExternalExamResultInput,
): Promise<{ scores: CheckedScore[]; total: number | null; subjectId: string | null }> {
  const subjectId = input.subject_id ?? null;
  if (exam.per_subject && subjectId === null) {
    invalid([
      {
        code: "SUBJECT_REQUIRED",
        severity: "error",
        message: `${exam.name} is recorded per subject: choose the subject.`,
      },
    ]);
  }
  if (!exam.per_subject && subjectId !== null) {
    invalid([
      {
        code: "SUBJECT_NOT_ALLOWED",
        severity: "error",
        message: `${exam.name} is not recorded per subject.`,
      },
    ]);
  }
  if (subjectId !== null) {
    const [subject] = await tx<{ id: string }[]>`
      SELECT id FROM app.subjects WHERE id = ${subjectId}::uuid AND school_id = ${schoolId}::uuid
    `;
    if (!subject) notFound("Subject not found");
  }

  const components = await loadComponents(tx, schoolId, [exam.id]);
  const byId = new Map(components.map((row) => [row.id, row]));
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const scores: CheckedScore[] = [];
  if (input.scores.length === 0) {
    issues.push({
      code: "SCORES_REQUIRED",
      severity: "error",
      message: "Enter at least one score.",
    });
  }
  for (const score of input.scores) {
    const row = byId.get(score.component_id);
    if (!row || seen.has(score.component_id)) {
      issues.push({
        code: "COMPONENT_UNKNOWN",
        severity: "error",
        message: `Component ${score.component_id} is not part of ${exam.name}, or is scored twice.`,
      });
      continue;
    }
    seen.add(score.component_id);
    const numeric = score.numeric_score ?? null;
    const label = score.label_score ?? null;
    if ((numeric === null) === (label === null)) {
      issues.push({
        code: "SCORE_REQUIRED",
        severity: "error",
        message: `Give "${row.name}" either a number or a grade.`,
      });
      continue;
    }
    const problem = validateExternalExamScore(toComponentDefinition(row), numeric ?? label!);
    if (problem) {
      issues.push(problem);
      continue;
    }
    scores.push({ componentId: row.id, numeric, label });
  }
  if (issues.length > 0) invalid(issues);

  const byComponent = new Map(scores.map((score) => [score.componentId, score]));
  const total = computeExternalExamTotal(
    { totalMode: exam.total_mode, totalRoundingStep: num(exam.total_rounding_step) },
    components.map((row) => {
      const score = byComponent.get(row.id);
      return score ? (score.numeric ?? score.label) : null;
    }),
  );
  return { scores, total, subjectId };
}

async function writeScores(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  examId: string,
  resultId: string,
  scores: readonly CheckedScore[],
): Promise<void> {
  for (const score of scores) {
    await tx`
      INSERT INTO app.student_external_exam_scores (
        school_id, result_id, student_id, exam_id, component_id, numeric_score, label_score
      )
      VALUES (
        ${schoolId}::uuid, ${resultId}::uuid, ${studentId}::uuid, ${examId}::uuid,
        ${score.componentId}::uuid, ${score.numeric}, ${score.label}
      )
    `;
  }
}

function auditScores(scores: readonly CheckedScore[]) {
  return scores.map((score) => ({
    component_id: score.componentId,
    score: score.numeric ?? score.label,
  }));
}

export async function recordExternalExamResult(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  studentId: string,
  input: ExternalExamResultInput & { exam_id: string },
): Promise<ExternalExamResultView> {
  await requireStudent(tx, schoolId, studentId);
  const exam = await requireExamRow(tx, schoolId, input.exam_id);
  if (exam.archived_at !== null) {
    conflict(`${exam.name} is archived: restore it to record new results`);
  }
  const { scores, total, subjectId } = await checkResult(tx, schoolId, exam, input);
  const entryId = input.entry_id ?? null;
  if (entryId !== null) {
    await checkResultEntry(tx, schoolId, entryId, { studentId, examId: exam.id, subjectId });
  }
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.student_external_exam_results (
      school_id, student_id, exam_id, subject_id, entry_id, sat_on, total_score, note,
      recorded_by_user_id
    )
    VALUES (
      ${schoolId}::uuid, ${studentId}::uuid, ${exam.id}::uuid, ${subjectId}::uuid,
      ${entryId}::uuid, ${input.sat_on}::date, ${total}, ${input.note ?? null}, ${userId}::uuid
    )
    RETURNING id
  `;
  await writeScores(tx, schoolId, studentId, exam.id, row!.id, scores);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "student_external_exam_results",
    targetId: row!.id,
    newValues: {
      student_id: studentId,
      exam_id: exam.id,
      subject_id: subjectId,
      entry_id: entryId,
      sat_on: input.sat_on,
      total_score: total,
      scores: auditScores(scores),
    },
  });
  return getResult(tx, schoolId, row!.id);
}

async function requireResultRow(tx: TransactionSql, schoolId: string, resultId: string) {
  const [row] = await tx<
    {
      id: string;
      student_id: string;
      exam_id: string;
      subject_id: string | null;
      entry_id: string | null;
      sat_on: string;
      total_score: string | null;
    }[]
  >`
    SELECT id, student_id, exam_id, subject_id, entry_id, sat_on::text AS sat_on,
           total_score::text AS total_score
    FROM app.student_external_exam_results
    WHERE id = ${resultId}::uuid AND school_id = ${schoolId}::uuid
    FOR UPDATE
  `;
  if (!row) notFound("External exam result not found");
  return row;
}

/** Replace a result's subject, date, note and scores; the total is worked out again. */
export async function updateExternalExamResult(
  tx: TransactionSql,
  schoolId: string,
  resultId: string,
  input: ExternalExamResultInput,
): Promise<ExternalExamResultView> {
  const before = await requireResultRow(tx, schoolId, resultId);
  const exam = await requireExamRow(tx, schoolId, before.exam_id);
  const { scores, total, subjectId } = await checkResult(tx, schoolId, exam, input);
  const entryId = input.entry_id === undefined ? before.entry_id : input.entry_id;
  if (entryId !== null) {
    await checkResultEntry(tx, schoolId, entryId, {
      studentId: before.student_id,
      examId: exam.id,
      subjectId,
    });
  }
  const [oldScores] = await tx<{ scores: { component_id: string; score: string }[] | null }[]>`
    SELECT json_agg(json_build_object(
             'component_id', component_id,
             'score', coalesce(numeric_score::text, label_score)
           )) AS scores
    FROM app.student_external_exam_scores
    WHERE school_id = ${schoolId}::uuid AND result_id = ${resultId}::uuid
  `;
  await tx`
    UPDATE app.student_external_exam_results
    SET subject_id = ${subjectId}::uuid, entry_id = ${entryId}::uuid,
        sat_on = ${input.sat_on}::date, total_score = ${total},
        note = ${input.note ?? null}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${resultId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await tx`
    DELETE FROM app.student_external_exam_scores
    WHERE school_id = ${schoolId}::uuid AND result_id = ${resultId}::uuid
  `;
  await writeScores(tx, schoolId, before.student_id, exam.id, resultId, scores);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "student_external_exam_results",
    targetId: resultId,
    oldValues: {
      subject_id: before.subject_id,
      entry_id: before.entry_id,
      sat_on: before.sat_on,
      total_score: num(before.total_score),
      scores: oldScores?.scores ?? [],
    },
    newValues: {
      subject_id: subjectId,
      entry_id: entryId,
      sat_on: input.sat_on,
      total_score: total,
      scores: auditScores(scores),
    },
  });
  return getResult(tx, schoolId, resultId);
}

export async function deleteExternalExamResult(
  tx: TransactionSql,
  schoolId: string,
  resultId: string,
): Promise<void> {
  const before = await requireResultRow(tx, schoolId, resultId);
  await tx`
    DELETE FROM app.student_external_exam_results
    WHERE id = ${resultId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "student_external_exam_results",
    targetId: resultId,
    oldValues: {
      student_id: before.student_id,
      exam_id: before.exam_id,
      subject_id: before.subject_id,
      sat_on: before.sat_on,
      total_score: num(before.total_score),
    },
  });
}

// ---------------------------------------------------------------------------
// Results recorded from an exam entry (000262)
// ---------------------------------------------------------------------------

/**
 * Check that a result may link to `entryId`: an entry in the school, of the result's own student
 * and exam, sent to the board, and -- when the entry lists subjects -- covering the result's subject.
 */
async function checkResultEntry(
  tx: TransactionSql,
  schoolId: string,
  entryId: string,
  result: { studentId: string; examId: string; subjectId: string | null },
): Promise<void> {
  const [entry] = await tx<
    {
      student_id: string;
      exam_id: string;
      status: "draft" | "entered" | "withdrawn";
      subject_ids: string[];
    }[]
  >`
    SELECT entry.student_id, entry.exam_id, entry.status,
           coalesce(array_agg(entered.subject_id) FILTER (WHERE entered.subject_id IS NOT NULL),
                    '{}') AS subject_ids
    FROM app.external_exam_entries AS entry
    LEFT JOIN app.external_exam_entry_subjects AS entered
      ON entered.entry_id = entry.id AND entered.school_id = entry.school_id
    WHERE entry.id = ${entryId}::uuid AND entry.school_id = ${schoolId}::uuid
    GROUP BY entry.id
  `;
  if (!entry) notFound("Exam entry not found");
  const mismatch = (code: string, message: string): never =>
    invalid([{ code, severity: "error", message }]);
  if (entry.student_id !== result.studentId || entry.exam_id !== result.examId) {
    mismatch("ENTRY_MISMATCH", "The exam entry is for another student or exam.");
  }
  if (entry.status === "draft") {
    mismatch("ENTRY_DRAFT", "A draft exam entry was never sent to the board.");
  }
  if (
    result.subjectId !== null &&
    entry.subject_ids.length > 0 &&
    !entry.subject_ids.includes(result.subjectId)
  ) {
    mismatch("ENTRY_SUBJECT", "The student was not entered for this subject in that exam entry.");
  }
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export interface TranscriptExternalExam {
  code: string;
  name: string;
  total_max: number | null;
  results: {
    subject: { code: string; name: string } | null;
    sat_on: string;
    total_score: number | null;
    scores: {
      component: string;
      numeric_score: number | null;
      label_score: string | null;
      max_score: number | null;
    }[];
  }[];
}

/**
 * The student's results in every exam shown on transcripts, grouped by exam (by name) with each
 * exam's sittings oldest first, as copied into a transcript's content when it is issued.
 */
export async function transcriptExternalExams(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<TranscriptExternalExam[]> {
  const results = await loadResults(tx, schoolId, { studentId });
  if (results.length === 0) return [];
  const shown = new Set(
    (
      await tx<{ id: string }[]>`
        SELECT id FROM app.external_exams
        WHERE school_id = ${schoolId}::uuid AND show_on_transcript
          AND id = ANY (${[...new Set(results.map((result) => result.exam.id))]}::uuid[])
      `
    ).map((row) => row.id),
  );
  const exams = new Map<string, TranscriptExternalExam>();
  for (const result of [...results].reverse()) {
    if (!shown.has(result.exam.id)) continue;
    let exam = exams.get(result.exam.id);
    if (!exam) {
      exam = {
        code: result.exam.code,
        name: result.exam.name,
        total_max: result.exam.total_max,
        results: [],
      };
      exams.set(result.exam.id, exam);
    }
    exam.results.push({
      subject: result.subject ? { code: result.subject.code, name: result.subject.name } : null,
      sat_on: result.sat_on,
      total_score: result.total_score,
      scores: result.scores.map((score) => ({
        component: score.component_name,
        numeric_score: score.numeric_score,
        label_score: score.label_score,
        max_score: score.max_score,
      })),
    });
  }
  return [...exams.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code),
  );
}
