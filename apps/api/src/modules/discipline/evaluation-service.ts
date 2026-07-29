import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type {
  EvaluationType,
  EvaluationRating,
  EvaluationStatus,
  CreateEvaluationBody,
  UpdateEvaluationBody,
  CreateCriteriaTemplateBody,
  UpdateCriteriaTemplateBody,
  UpsertScoreBody,
} from "./evaluation-schemas";
import type { TransactionSql } from "postgres";

export interface EvaluationRow {
  id: string;
  school_id: string;
  teacher_id: string;
  evaluator_user_id: string;
  class_id: string | null;
  evaluation_type: EvaluationType;
  rating: EvaluationRating | null;
  strengths: string | null;
  areas_for_improvement: string | null;
  comments: string | null;
  narrative: string | null;
  status: EvaluationStatus;
  shared_with_teacher: boolean;
  shared_at: Date | null;
  evaluated_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface EvaluationWithScoresRow extends EvaluationRow {
  scores: EvaluationScoreRow[];
}

export interface EvaluationCriteriaTemplateRow {
  id: string;
  school_id: string;
  title: string;
  description: string | null;
  max_score: number;
  sort_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface EvaluationScoreRow {
  id: string;
  school_id: string;
  evaluation_id: string;
  criteria_template_id: string;
  score: number;
  comment: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListEvaluationsParams {
  limit: number;
  offset: number;
  teacher_id?: string;
  evaluation_type?: string;
  status?: string;
}

export interface ListTemplatesParams {
  limit: number;
  offset: number;
  is_active?: boolean;
}

const EVALUATION_COLUMNS = `
  id, school_id, teacher_id, evaluator_user_id, class_id,
  evaluation_type::text AS evaluation_type, rating::text AS rating,
  status::text AS status,
  strengths, areas_for_improvement, comments, narrative,
  shared_with_teacher, shared_at, evaluated_at, created_at, updated_at
`;

const TEMPLATE_COLUMNS = `
  id, school_id, title, description, max_score, sort_order, is_active, created_at, updated_at
`;

const SCORE_COLUMNS = `
  s.id, s.school_id, s.evaluation_id, s.criteria_template_id, s.score, s.comment,
  s.created_at, s.updated_at
`;

const VALID_EVALUATION_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  draft: new Set(["submitted"]),
  submitted: new Set(["finalized"]),
  finalized: new Set(),
};

function parseEvaluationRow(row: Record<string, unknown>): EvaluationRow {
  return {
    id: row.id as string,
    school_id: row.school_id as string,
    teacher_id: row.teacher_id as string,
    evaluator_user_id: row.evaluator_user_id as string,
    class_id: row.class_id as string | null,
    evaluation_type: row.evaluation_type as EvaluationType,
    rating: row.rating as EvaluationRating | null,
    strengths: row.strengths as string | null,
    areas_for_improvement: row.areas_for_improvement as string | null,
    comments: row.comments as string | null,
    narrative: row.narrative as string | null,
    status: row.status as EvaluationStatus,
    shared_with_teacher: row.shared_with_teacher as boolean,
    shared_at: row.shared_at as Date | null,
    evaluated_at: row.evaluated_at as Date,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

function parseTemplateRow(row: Record<string, unknown>): EvaluationCriteriaTemplateRow {
  return {
    id: row.id as string,
    school_id: row.school_id as string,
    title: row.title as string,
    description: row.description as string | null,
    max_score: Number(row.max_score),
    sort_order: row.sort_order as number,
    is_active: row.is_active as boolean,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

function parseScoreRow(row: Record<string, unknown>): EvaluationScoreRow {
  return {
    id: row.id as string,
    school_id: row.school_id as string,
    evaluation_id: row.evaluation_id as string,
    criteria_template_id: row.criteria_template_id as string,
    score: Number(row.score),
    comment: row.comment as string | null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

// ---------------------------------------------------------------------------
// Criteria templates
// ---------------------------------------------------------------------------

export async function listTemplates(
  tx: TransactionSql,
  schoolId: string,
  params: ListTemplatesParams,
): Promise<{ rows: EvaluationCriteriaTemplateRow[]; total: number }> {
  const activeFilter =
    params.is_active !== undefined ? tx` AND t.is_active = ${params.is_active}` : tx``;

  const [rows, countResult] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(TEMPLATE_COLUMNS)}
      FROM app.evaluation_criteria_templates t
      WHERE t.school_id = ${schoolId}::uuid
        ${activeFilter}
      ORDER BY t.sort_order ASC, t.title ASC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.evaluation_criteria_templates t
      WHERE t.school_id = ${schoolId}::uuid
        ${activeFilter}
    `,
  ]);

  return {
    rows: rows.map(parseTemplateRow),
    total: Number(countResult[0]?.count ?? 0),
  };
}

export async function getTemplate(
  tx: TransactionSql,
  schoolId: string,
  templateId: string,
): Promise<EvaluationCriteriaTemplateRow | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(TEMPLATE_COLUMNS)}
    FROM app.evaluation_criteria_templates
    WHERE id = ${templateId}::uuid AND school_id = ${schoolId}::uuid
  `;
  return row ? parseTemplateRow(row) : undefined;
}

export async function createTemplate(
  tx: TransactionSql,
  schoolId: string,
  params: CreateCriteriaTemplateBody,
): Promise<EvaluationCriteriaTemplateRow> {
  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.evaluation_criteria_templates
      (school_id, title, description, max_score, sort_order)
    VALUES (
      ${schoolId}::uuid,
      ${params.title},
      ${params.description ?? null},
      ${params.max_score}::numeric(5,2),
      ${params.sort_order ?? 0}::smallint
    )
    RETURNING ${tx.unsafe(TEMPLATE_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(500, { message: "Failed to create criteria template" });
  }

  const template = parseTemplateRow(row);

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "evaluation_criteria_templates",
    targetId: template.id,
    newValues: {
      title: params.title,
      description: params.description ?? null,
      max_score: params.max_score,
      sort_order: params.sort_order ?? 0,
    },
  });

  return template;
}

export async function updateTemplate(
  tx: TransactionSql,
  schoolId: string,
  templateId: string,
  params: UpdateCriteriaTemplateBody,
): Promise<EvaluationCriteriaTemplateRow> {
  const existing = await getTemplate(tx, schoolId, templateId);
  if (!existing) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.EVALUATION_TEMPLATE_NOT_FOUND,
      "Evaluation criteria template not found",
    );
  }

  const [row] = await tx<Record<string, unknown>[]>`
    UPDATE app.evaluation_criteria_templates SET
      title = COALESCE(${params.title ?? null}, title),
      description = CASE WHEN ${"description" in params} THEN ${params.description ?? null} ELSE description END,
      max_score = COALESCE(${params.max_score ?? null}::numeric(5,2), max_score),
      sort_order = COALESCE(${params.sort_order ?? null}::smallint, sort_order),
      is_active = COALESCE(${params.is_active ?? null}, is_active),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${templateId}::uuid AND school_id = ${schoolId}::uuid
    RETURNING ${tx.unsafe(TEMPLATE_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Evaluation criteria template not found" });
  }

  const template = parseTemplateRow(row);

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "evaluation_criteria_templates",
    targetId: templateId,
    oldValues: {
      title: existing.title,
      description: existing.description,
      max_score: existing.max_score,
      sort_order: existing.sort_order,
      is_active: existing.is_active,
    },
    newValues: {
      title: template.title,
      description: template.description,
      max_score: template.max_score,
      sort_order: template.sort_order,
      is_active: template.is_active,
    },
  });

  return template;
}

export async function deleteTemplate(
  tx: TransactionSql,
  schoolId: string,
  templateId: string,
): Promise<void> {
  const existing = await getTemplate(tx, schoolId, templateId);
  if (!existing) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.EVALUATION_TEMPLATE_NOT_FOUND,
      "Evaluation criteria template not found",
    );
  }

  await tx`
    UPDATE app.evaluation_criteria_templates SET
      is_active = false,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${templateId}::uuid AND school_id = ${schoolId}::uuid
  `;

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "evaluation_criteria_templates",
    targetId: templateId,
    oldValues: { is_active: true },
    newValues: { is_active: false },
  });
}

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

export async function listEvaluations(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  isTeacher: boolean,
  params: ListEvaluationsParams,
): Promise<{ rows: EvaluationWithScoresRow[]; total: number }> {
  const teacherFilter = isTeacher
    ? tx` AND e.teacher_id IN (
    SELECT id FROM app.teachers WHERE user_id = ${userId}::uuid AND school_id = ${schoolId}::uuid
  ) AND e.shared_with_teacher = true`
    : tx``;
  const typeFilter = params.evaluation_type
    ? tx` AND e.evaluation_type = ${params.evaluation_type}::app.evaluation_type`
    : tx``;
  const statusFilter = params.status
    ? tx` AND e.status = ${params.status}::app.evaluation_status`
    : tx``;
  const teacherIdFilter = params.teacher_id
    ? tx` AND e.teacher_id = ${params.teacher_id}::uuid`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(EVALUATION_COLUMNS)}
      FROM app.teacher_evaluations e
      WHERE e.school_id = ${schoolId}::uuid
        ${teacherFilter}
        ${typeFilter}
        ${statusFilter}
        ${teacherIdFilter}
      ORDER BY e.evaluated_at DESC, e.id DESC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.teacher_evaluations e
      WHERE e.school_id = ${schoolId}::uuid
        ${teacherFilter}
        ${typeFilter}
        ${statusFilter}
        ${teacherIdFilter}
    `,
  ]);

  const evaluations = rows.map(parseEvaluationRow);
  const withScores = await Promise.all(
    evaluations.map(async (e) => {
      const scores = await listScoresForEvaluation(tx, schoolId, e.id);
      return { ...e, scores };
    }),
  );

  return {
    rows: withScores,
    total: Number(countResult[0]?.count ?? 0),
  };
}

export async function getEvaluation(
  tx: TransactionSql,
  schoolId: string,
  evaluationId: string,
): Promise<EvaluationWithScoresRow | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(EVALUATION_COLUMNS)}
    FROM app.teacher_evaluations
    WHERE id = ${evaluationId}::uuid AND school_id = ${schoolId}::uuid
  `;

  if (!row) return undefined;

  const evaluation = parseEvaluationRow(row);
  const scores = await listScoresForEvaluation(tx, schoolId, evaluationId);

  return { ...evaluation, scores };
}

export async function createEvaluation(
  tx: TransactionSql,
  schoolId: string,
  evaluatorUserId: string,
  params: CreateEvaluationBody,
): Promise<EvaluationRow> {
  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.teacher_evaluations
      (school_id, teacher_id, evaluator_user_id, class_id,
       evaluation_type, rating, strengths, areas_for_improvement,
       comments, narrative, evaluated_at)
    VALUES (
      ${schoolId}::uuid, ${params.teacher_id}::uuid, ${evaluatorUserId}::uuid,
      ${params.class_id ?? null}::uuid,
      ${params.evaluation_type}::app.evaluation_type,
      ${params.rating ?? null}::app.evaluation_rating,
      ${params.strengths ?? null},
      ${params.areas_for_improvement ?? null},
      ${params.comments ?? null},
      ${params.narrative ?? null},
      ${params.evaluated_at}::timestamptz
    )
    RETURNING ${tx.unsafe(EVALUATION_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(500, { message: "Failed to create evaluation" });
  }

  const evaluation = parseEvaluationRow(row);

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "teacher_evaluations",
    targetId: evaluation.id,
    newValues: {
      teacher_id: params.teacher_id,
      evaluation_type: params.evaluation_type,
      rating: params.rating ?? null,
      evaluated_at: params.evaluated_at,
    },
  });

  return evaluation;
}

export async function updateEvaluation(
  tx: TransactionSql,
  schoolId: string,
  evaluationId: string,
  params: UpdateEvaluationBody,
): Promise<EvaluationRow> {
  const existing = await getEvaluation(tx, schoolId, evaluationId);
  if (!existing) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.EVALUATION_NOT_FOUND,
      "Teacher evaluation not found",
    );
  }

  const [row] = await tx<Record<string, unknown>[]>`
    UPDATE app.teacher_evaluations SET
      rating = CASE WHEN ${"rating" in params} THEN ${params.rating ?? null}::app.evaluation_rating ELSE rating END,
      strengths = CASE WHEN ${"strengths" in params} THEN ${params.strengths ?? null} ELSE strengths END,
      areas_for_improvement = CASE WHEN ${"areas_for_improvement" in params} THEN ${params.areas_for_improvement ?? null} ELSE areas_for_improvement END,
      comments = CASE WHEN ${"comments" in params} THEN ${params.comments ?? null} ELSE comments END,
      narrative = CASE WHEN ${"narrative" in params} THEN ${params.narrative ?? null} ELSE narrative END,
      class_id = CASE WHEN ${"class_id" in params} THEN ${params.class_id ?? null}::uuid ELSE class_id END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${evaluationId}::uuid AND school_id = ${schoolId}::uuid
    RETURNING ${tx.unsafe(EVALUATION_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Teacher evaluation not found" });
  }

  const evaluation = parseEvaluationRow(row);

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "teacher_evaluations",
    targetId: evaluationId,
    oldValues: {
      rating: existing.rating,
      strengths: existing.strengths,
      areas_for_improvement: existing.areas_for_improvement,
      comments: existing.comments,
      narrative: existing.narrative,
    },
    newValues: {
      rating: evaluation.rating,
      strengths: evaluation.strengths,
      areas_for_improvement: evaluation.areas_for_improvement,
      comments: evaluation.comments,
      narrative: evaluation.narrative,
    },
  });

  return evaluation;
}

export async function submitEvaluation(
  tx: TransactionSql,
  schoolId: string,
  evaluationId: string,
): Promise<EvaluationRow> {
  const existing = await getEvaluation(tx, schoolId, evaluationId);
  if (!existing) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.EVALUATION_NOT_FOUND,
      "Teacher evaluation not found",
    );
  }

  const allowed = VALID_EVALUATION_TRANSITIONS[existing.status];
  if (!allowed || !allowed.has("submitted")) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.EVALUATION_INVALID_STATUS_TRANSITION,
      `Cannot submit evaluation in '${existing.status}' status`,
    );
  }

  const [row] = await tx<Record<string, unknown>[]>`
    UPDATE app.teacher_evaluations SET
      status = 'submitted'::app.evaluation_status,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${evaluationId}::uuid AND school_id = ${schoolId}::uuid
    RETURNING ${tx.unsafe(EVALUATION_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Teacher evaluation not found" });
  }

  const evaluation = parseEvaluationRow(row);

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "teacher_evaluations",
    targetId: evaluationId,
    oldValues: { status: existing.status },
    newValues: { status: "submitted" },
  });

  return evaluation;
}

export async function shareEvaluationWithTeacher(
  tx: TransactionSql,
  schoolId: string,
  evaluationId: string,
): Promise<EvaluationRow> {
  const existing = await getEvaluation(tx, schoolId, evaluationId);
  if (!existing) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.EVALUATION_NOT_FOUND,
      "Teacher evaluation not found",
    );
  }

  if (existing.shared_with_teacher) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.EVALUATION_ALREADY_SHARED,
      "Evaluation is already shared with the teacher",
    );
  }

  const [row] = await tx<Record<string, unknown>[]>`
    UPDATE app.teacher_evaluations SET
      shared_with_teacher = true,
      shared_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${evaluationId}::uuid AND school_id = ${schoolId}::uuid
    RETURNING ${tx.unsafe(EVALUATION_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Teacher evaluation not found" });
  }

  const evaluation = parseEvaluationRow(row);

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "teacher_evaluations",
    targetId: evaluationId,
    oldValues: { shared_with_teacher: false, shared_at: null },
    newValues: { shared_with_teacher: true, shared_at: new Date().toISOString() },
  });

  return evaluation;
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

async function listScoresForEvaluation(
  tx: TransactionSql,
  schoolId: string,
  evaluationId: string,
): Promise<EvaluationScoreRow[]> {
  const rows = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(SCORE_COLUMNS)}
    FROM app.evaluation_scores s
    WHERE s.school_id = ${schoolId}::uuid
      AND s.evaluation_id = ${evaluationId}::uuid
    ORDER BY s.id ASC
  `;

  return rows.map(parseScoreRow);
}

export async function getEvaluationScores(
  tx: TransactionSql,
  schoolId: string,
  evaluationId: string,
): Promise<EvaluationScoreRow[]> {
  return listScoresForEvaluation(tx, schoolId, evaluationId);
}

export async function upsertScore(
  tx: TransactionSql,
  schoolId: string,
  evaluationId: string,
  criteriaTemplateId: string,
  params: UpsertScoreBody,
): Promise<EvaluationScoreRow> {
  const evaluation = await getEvaluation(tx, schoolId, evaluationId);
  if (!evaluation) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.EVALUATION_NOT_FOUND,
      "Teacher evaluation not found",
    );
  }

  const template = await getTemplate(tx, schoolId, criteriaTemplateId);
  if (!template) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.EVALUATION_TEMPLATE_NOT_FOUND,
      "Evaluation criteria template not found",
    );
  }

  if (params.score > template.max_score) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `Score (${params.score}) exceeds template max score (${template.max_score})`,
    );
  }

  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.evaluation_scores
      (school_id, evaluation_id, criteria_template_id, score, comment)
    VALUES (
      ${schoolId}::uuid, ${evaluationId}::uuid,
      ${criteriaTemplateId}::uuid,
      ${params.score}::numeric(5,2),
      ${params.comment ?? null}
    )
    ON CONFLICT (evaluation_id, criteria_template_id)
    DO UPDATE SET
      score = EXCLUDED.score,
      comment = EXCLUDED.comment,
      updated_at = CURRENT_TIMESTAMP
    RETURNING ${tx.unsafe(SCORE_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(500, { message: "Failed to upsert score" });
  }

  const score = parseScoreRow(row);

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "evaluation_scores",
    targetId: score.id,
    newValues: {
      evaluation_id: evaluationId,
      criteria_template_id: criteriaTemplateId,
      score: params.score,
      comment: params.comment ?? null,
    },
  });

  return score;
}

export async function deleteScore(
  tx: TransactionSql,
  schoolId: string,
  evaluationId: string,
  criteriaTemplateId: string,
): Promise<void> {
  const evaluation = await getEvaluation(tx, schoolId, evaluationId);
  if (!evaluation) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.EVALUATION_NOT_FOUND,
      "Teacher evaluation not found",
    );
  }

  const [existing] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(SCORE_COLUMNS)}
    FROM app.evaluation_scores s
    WHERE s.school_id = ${schoolId}::uuid
      AND s.evaluation_id = ${evaluationId}::uuid
      AND s.criteria_template_id = ${criteriaTemplateId}::uuid
  `;

  if (!existing) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.EVALUATION_SCORE_NOT_FOUND,
      "Evaluation score not found",
    );
  }

  await tx`
    DELETE FROM app.evaluation_scores
    WHERE school_id = ${schoolId}::uuid
      AND evaluation_id = ${evaluationId}::uuid
      AND criteria_template_id = ${criteriaTemplateId}::uuid
  `;

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "evaluation_scores",
    targetId: existing.id as string,
    oldValues: {
      score: existing.score as number,
      criteria_template_id: criteriaTemplateId,
    },
  });
}
