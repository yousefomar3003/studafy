import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  AI_EXAM_DEFAULT_DURATION_MINUTES,
  AI_EXAM_DEFAULT_QUESTIONS,
  AI_EXAM_MAX_DURATION_MINUTES,
  AI_EXAM_MAX_MATERIALS,
  AI_EXAM_MAX_QUESTIONS,
  AI_EXAM_MIN_DURATION_MINUTES,
  AI_EXAM_MIN_QUESTIONS,
  ERROR_CODES,
  EXAM_GENERATION_JOB_OPTIONS,
  JOB_NAMES,
  QUEUE_NAMES,
} from "@studafy/constants";
import { Queue } from "bullmq";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  AI_EXAM_MAX_RESERVE_TOKENS,
  AI_EXAM_OUTPUT_TOKEN_BUFFER,
  AI_EXAM_OUTPUT_TOKENS_CEILING,
  AI_EXAM_OUTPUT_TOKENS_PER_ITEM,
} from "../config";
import { EXAM_ITEM_TYPES, gradeExam } from "../exam/grading";
import { validateExamMaterials } from "../exam/materials";
import {
  createExamSession,
  failExamSessionEnqueue,
  loadExamItems,
  loadExamItemsForGrading,
  loadExamSession,
  startExamSession,
  submitExamAnswers,
} from "../exam/persistence";
import { loadExamReport } from "../exam/report";
import { getAiQuota } from "../gate/entitlement-gate";
import { AI_FEATURES, AI_MODEL_TIERS, resolveAiModel } from "../llm/routing";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { ExamItemType } from "../exam/grading";
import type { ExamItemView, ExamSessionRow } from "../exam/persistence";
import type { ExamReport } from "../exam/report";
import type { AiModelTier } from "../llm/routing";
import type { Context } from "hono";

/**
 * Exam mode (ST-171): timed mock exams over a chosen scope, grounded in the corpus.
 *
 * Unlike every other `/api/ai/*` surface, generation does not run on the request path: an exam's
 * item bank is heavy (up to `AI_EXAM_MAX_QUESTIONS` mixed mcq/short-answer items across up to
 * `AI_EXAM_MAX_MATERIALS` materials), so `POST .../exams` only validates the requested scope,
 * creates the `app.exam_sessions` row, and enqueues `QUEUE_NAMES.AI_EXAM_GENERATION` --
 * `apps/workers/src/queues/exam-generation` does the actual model call, using the same three-layer
 * grounded validator (Zod schema, source-id bounds, DB CHECK constraint) quiz generation
 * established. `GET .../exams/{examId}` is the progress-status endpoint a client polls; its response
 * shape depends on the session's `status`, the same "one resource, evolving representation" pattern
 * `finance/reports/routes.ts`'s export job status uses.
 *
 * The timer is enforced server-side across two mutating actions, not embedded in generation:
 * `POST .../start` (`ready -> in_progress`) stamps `started_at`/`expires_at` from the *server's*
 * clock, and `POST .../submit` (`in_progress -> submitted`) refuses with 409 `AI_EXAM_EXPIRED` once
 * `now() > expires_at` -- a client cannot extend its own time budget by any request it controls.
 * `GET` never mutates state, so refreshing a status page can never start the clock.
 *
 * Scoring is deterministic (`exam/grading.ts`, the same MCQ-exact-match / normalized-short-answer
 * algorithm `quiz/grading.ts` uses), and submit persists what was answered
 * (`app.exam_item_answers`) so the per-topic weakness report (`exam/report.ts`) is re-fetchable by
 * `GET` after the fact rather than a one-shot response nobody can see again.
 *
 * ## Quota
 *
 * Unlike the synchronous AI surfaces, `POST .../exams` commits `AI_EXAM_MAX_RESERVE_TOKENS` in full
 * at create time rather than metering the worker's actual usage after the fact -- an async job in a
 * different process cannot settle the same Redis-scripted reservation the ST-155 gate holds without
 * carrying that meter across the process boundary. This is a disclosed trade-off; see config.ts and
 * docs/rag/exam-mode.md. `GET` / `start` / `submit` make no LLM call and settle at zero, the same
 * posture quiz's grading endpoint takes.
 *
 * ## Error surface
 *
 * Create: the shared ST-155 gate 403/402/429; a material the school cannot see or with no ingested
 * text -> 404 `RESOURCE_NOT_FOUND`; a material still mid-ingestion -> 422 `VALIDATION_FAILED`; the
 * queue or its Redis connection unconfigured, or an enqueue failure -> 503
 * `AI_EXAM_GENERATION_UNAVAILABLE`.
 *
 * Get / start / submit: a session that does not exist, or belongs to a different student -> 404
 * `AI_EXAM_NOT_FOUND`; start or submit called from a status that does not allow it -> 409
 * `AI_EXAM_INVALID_STATE`; submit called after `expires_at` -> 409 `AI_EXAM_EXPIRED`; an answer
 * naming an item id outside the session -> 422 `VALIDATION_FAILED`.
 */

const EXAM_FEATURE: (typeof AI_FEATURES)[number] = "exam";

// ---------------------------------------------------------------------------------------------------
// Shared response shapes
// ---------------------------------------------------------------------------------------------------

const examOptionSchema = z.object({
  id: z.string(),
  text: z.string(),
});

const examCitationSchema = z.object({
  chunk_id: z.string().uuid(),
  material_id: z.string().uuid(),
  material_title: z.string().nullable(),
  page_number: z.number().int().nullable(),
  section_title: z.string().nullable(),
});

const examUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});

const examItemResponseSchema = z.object({
  id: z.string().uuid(),
  order: z.number().int().min(1),
  type: z.enum(EXAM_ITEM_TYPES),
  prompt: z.string(),
  /** The choices for an `mcq` item, in generation order. Null for `short_answer`. Never reveals which is correct. */
  options: z.array(examOptionSchema).nullable(),
  citation: examCitationSchema,
});

const examStudyReferenceSchema = z.object({
  chunk_id: z.string().uuid(),
  page_number: z.number().int().nullable(),
  section_title: z.string().nullable(),
});

const examTopicReportSchema = z.object({
  material_id: z.string().uuid(),
  material_title: z.string().nullable(),
  correct: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  percentage: z.number().int().min(0).max(100),
  weak: z.boolean(),
  /** Citations of this topic's incorrect items only. */
  study_references: z.array(examStudyReferenceSchema),
});

const examReportResponseSchema = z.object({
  correct_count: z.number().int().nonnegative(),
  total_items: z.number().int().nonnegative(),
  percentage: z.number().int().min(0).max(100),
  topics: z.array(examTopicReportSchema),
});

/**
 * One resource, one shape, evolving by `status` -- the same convention
 * `finance/reports/routes.ts`'s `toJobResponse` uses. `items` is populated only once the session is
 * `in_progress` (never at `ready`, so nothing is visible before the student commits to starting the
 * clock); `report` only once `submitted`.
 */
const examSessionResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["generating", "ready", "in_progress", "submitted", "failed"]),
  model: z.string(),
  tier: z.enum(AI_MODEL_TIERS),
  feature: z.enum(AI_FEATURES),
  question_count: z.number().int().min(1),
  duration_minutes: z.number().int().min(1),
  created_at: z.string(),
  started_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  submitted_at: z.string().nullable(),
  failure_reason: z.string().nullable(),
  usage: examUsageSchema.nullable(),
  items: z.array(examItemResponseSchema).nullable(),
  report: examReportResponseSchema.nullable(),
  polling_url: z.string(),
});

function pollingUrl(studentId: string, examSessionId: string): string {
  return `/api/ai/students/${studentId}/exams/${examSessionId}`;
}

function toExamSessionResponse(
  session: ExamSessionRow,
  studentId: string,
  items: ExamItemView[] | null,
  report: ExamReport | null,
) {
  return {
    id: session.id,
    status: session.status,
    model: session.model,
    tier: session.tier as AiModelTier,
    feature: EXAM_FEATURE,
    question_count: session.questionCount,
    duration_minutes: session.durationMinutes,
    created_at: session.createdAt.toISOString(),
    started_at: session.startedAt?.toISOString() ?? null,
    expires_at: session.expiresAt?.toISOString() ?? null,
    submitted_at: session.submittedAt?.toISOString() ?? null,
    failure_reason: session.failureReason,
    usage:
      session.inputTokens !== null && session.outputTokens !== null
        ? { input_tokens: session.inputTokens, output_tokens: session.outputTokens }
        : null,
    items: items?.map((item) => itemAnchor(item)) ?? null,
    report: report ? reportAnchor(report) : null,
    polling_url: pollingUrl(studentId, session.id),
  };
}

function itemAnchor(item: ExamItemView) {
  return {
    id: item.id,
    order: item.order,
    type: item.type,
    prompt: item.prompt,
    options: item.options,
    citation: {
      chunk_id: item.citation.chunkId,
      material_id: item.citation.materialId,
      material_title: item.citation.materialTitle,
      page_number: item.citation.pageNumber,
      section_title: item.citation.sectionTitle,
    },
  };
}

function reportAnchor(report: ExamReport) {
  return {
    correct_count: report.correctCount,
    total_items: report.totalItems,
    percentage: report.percentage,
    topics: report.topics.map((topic) => ({
      material_id: topic.materialId,
      material_title: topic.materialTitle,
      correct: topic.correct,
      total: topic.total,
      percentage: topic.percentage,
      weak: topic.weak,
      study_references: topic.studyReferences.map((ref) => ({
        chunk_id: ref.chunkId,
        page_number: ref.pageNumber,
        section_title: ref.sectionTitle,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------------------------------

const examStudentParamsSchema = z.object({
  studentId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "studentId", in: "path" },
      description: "The student whose AI quota the exam draws on.",
    }),
});

const examSessionParamsSchema = examStudentParamsSchema.extend({
  examId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "examId", in: "path" },
      description: "The exam session, as returned by the create endpoint.",
    }),
});

// ---------------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------------

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

const createExamBodySchema = z.object({
  materialIds: z
    .array(z.string().uuid())
    .min(1)
    .max(AI_EXAM_MAX_MATERIALS)
    .refine((ids) => !hasDuplicates(ids), { message: "materialIds must not contain duplicates" })
    .openapi({
      description: `The materials that make up the exam's scope, up to ${AI_EXAM_MAX_MATERIALS}.`,
      example: ["0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12"],
    }),
  questionCount: z
    .number()
    .int()
    .min(AI_EXAM_MIN_QUESTIONS)
    .max(AI_EXAM_MAX_QUESTIONS)
    .optional()
    .openapi({
      description: `How many items to generate. Defaults to ${AI_EXAM_DEFAULT_QUESTIONS}, up to ${AI_EXAM_MAX_QUESTIONS}.`,
      example: 20,
    }),
  questionTypes: z
    .array(z.enum(EXAM_ITEM_TYPES))
    .min(1)
    .max(EXAM_ITEM_TYPES.length)
    .refine((types) => !hasDuplicates(types), {
      message: "questionTypes must not contain duplicates",
    })
    .optional()
    .openapi({
      description: "Which item types to mix. Defaults to both mcq and short_answer.",
      example: ["mcq", "short_answer"],
    }),
  durationMinutes: z
    .number()
    .int()
    .min(AI_EXAM_MIN_DURATION_MINUTES)
    .max(AI_EXAM_MAX_DURATION_MINUTES)
    .optional()
    .openapi({
      description: `The exam's server-enforced time limit, in minutes. Defaults to ${AI_EXAM_DEFAULT_DURATION_MINUTES}.`,
      example: 30,
    }),
});

const createExamRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/exams",
  tags: ["AI"],
  operationId: "createExam",
  summary: "Start generating a timed mock exam over a chosen scope",
  description:
    "Validates the requested materials, creates the exam session, and enqueues item-bank " +
    "generation onto a worker -- heavy generation never runs on the request path. Poll the " +
    "returned polling_url (GET) for progress; once status is 'ready', call the start endpoint to " +
    "begin the server-enforced timer. Refuses with 404 RESOURCE_NOT_FOUND for a material the " +
    "school cannot see or with no ingested text, 422 VALIDATION_FAILED while a material is still " +
    "mid-ingestion, and 503 AI_EXAM_GENERATION_UNAVAILABLE when the generation queue is not " +
    "configured or the enqueue itself fails.",
  security: [{ bearerAuth: [] }],
  request: {
    params: examStudentParamsSchema,
    body: { required: true, content: { "application/json": { schema: createExamBodySchema } } },
  },
  responses: standardResponses(
    {
      202: {
        description: "The exam session, generating in the background.",
        schema: examSessionResponseSchema,
      },
    },
    [400, 401, 402, 403, 404, 422, 429, 500, 503],
  ),
});

// ---------------------------------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------------------------------

const getExamRoute = createRoute({
  method: "get",
  path: "/api/ai/students/{studentId}/exams/{examId}",
  tags: ["AI"],
  operationId: "getExam",
  summary: "Poll an exam session's status, and read its content once available",
  description:
    "Side-effect-free: never mutates the session, so polling can never start the timer. The " +
    "response shape depends on status -- 'items' is populated only once the session is " +
    "'in_progress' (a preview is never shown at 'ready'), and 'report' only once 'submitted'. " +
    "Refuses with 404 AI_EXAM_NOT_FOUND for a session that does not exist or belongs to a " +
    "different student.",
  security: [{ bearerAuth: [] }],
  request: { params: examSessionParamsSchema },
  responses: standardResponses(
    {
      200: {
        description: "The exam session's current status and content.",
        schema: examSessionResponseSchema,
      },
    },
    [400, 401, 402, 403, 404, 429, 500, 503],
  ),
});

// ---------------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------------

const startExamRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/exams/{examId}/start",
  tags: ["AI"],
  operationId: "startExam",
  summary: "Begin the exam's server-enforced timer and reveal its items",
  description:
    "Transitions 'ready' -> 'in_progress': stamps started_at/expires_at from the server's clock " +
    "(the client cannot set or extend either) and returns every item's prompt, options, and " +
    "citation -- never the answer key. Refuses with 404 AI_EXAM_NOT_FOUND for a session that does " +
    "not exist or belongs to a different student, and 409 AI_EXAM_INVALID_STATE when the session " +
    "is not 'ready' (still generating, already started, already submitted, or failed).",
  security: [{ bearerAuth: [] }],
  request: { params: examSessionParamsSchema },
  responses: standardResponses(
    {
      200: {
        description: "The exam's items and its expiry time.",
        schema: examSessionResponseSchema,
      },
    },
    [400, 401, 402, 403, 404, 409, 429, 500, 503],
  ),
});

// ---------------------------------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------------------------------

const submitAnswerSchema = z.object({
  item_id: z.string().uuid(),
  answer: z.string().trim().min(1).max(1000),
});

const submitExamBodySchema = z.object({
  /** Unanswered items are graded wrong; omit them rather than sending an empty string. */
  answers: z.array(submitAnswerSchema).max(AI_EXAM_MAX_QUESTIONS),
});

const submitExamRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/exams/{examId}/submit",
  tags: ["AI"],
  operationId: "submitExam",
  summary: "Submit exam answers for deterministic scoring and a per-topic weakness report",
  description:
    "Transitions 'in_progress' -> 'submitted': refuses with 409 AI_EXAM_EXPIRED once " +
    "now() > expires_at -- the server-side timer enforcement -- scores MCQ by exact option-id " +
    "match and short-answer by normalized string equality, persists what was submitted, and " +
    "returns a per-topic report grouping items by the material they were grounded on, with study " +
    "references (citations of that topic's incorrect items) for every topic at or below the weak " +
    "threshold. Also refuses with 404 AI_EXAM_NOT_FOUND for a session that does not exist or " +
    "belongs to a different student, 409 AI_EXAM_INVALID_STATE when the session is not " +
    "'in_progress', and 422 VALIDATION_FAILED for an answer naming an item id outside the session.",
  security: [{ bearerAuth: [] }],
  request: {
    params: examSessionParamsSchema,
    body: { required: true, content: { "application/json": { schema: submitExamBodySchema } } },
  },
  responses: standardResponses(
    {
      200: {
        description: "The scored session and its per-topic report.",
        schema: examSessionResponseSchema,
      },
    },
    [400, 401, 402, 403, 404, 409, 422, 429, 500, 503],
  ),
});

// ---------------------------------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------------------------------

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/** `questionCount` scaled by an estimated per-item cost -- see config.ts for the reserve math. */
function examMaxTokens(questionCount: number): number {
  return Math.min(
    AI_EXAM_OUTPUT_TOKENS_CEILING,
    questionCount * AI_EXAM_OUTPUT_TOKENS_PER_ITEM + AI_EXAM_OUTPUT_TOKEN_BUFFER,
  );
}

export function aiExamRoutes(deps: {
  database: Database;
  /** Backs the generation queue's producer. Null (no Redis) answers 503 at request time. */
  redis: RedisClient | null;
  /** Environment overrides for the routing table's model ids (`AI_LLM_LARGE_MODEL`). */
  modelOverrides?: Partial<Record<AiModelTier, string>>;
}): OpenAPIHono<AppEnv> {
  const { database, redis, modelOverrides = {} } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const queue = redis
    ? new Queue(QUEUE_NAMES.AI_EXAM_GENERATION, { connection: redis as never })
    : null;

  // The audit-coverage gate (tests/audit-coverage.test.ts) requires every mutating route to declare
  // its audit intent. Get makes no write; start's substantive write is the session's status/timer
  // columns; submit's is the exam_item_answers it inserts.
  routes.use("/api/ai/students/{studentId}/exams", auditAction("insert", "exam_sessions"));
  routes.use("/api/ai/students/{studentId}/exams/{examId}", auditAction("read", "exam_sessions"));
  routes.use(
    "/api/ai/students/{studentId}/exams/{examId}/start",
    auditAction("update", "exam_sessions"),
  );
  routes.use(
    "/api/ai/students/{studentId}/exams/{examId}/submit",
    auditAction("insert", "exam_item_answers"),
  );

  routes.openapi(createExamRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const quota = getAiQuota(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;

    if (!queue) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.AI_EXAM_GENERATION_UNAVAILABLE,
        getLocalizedMessage(ERROR_CODES.AI_EXAM_GENERATION_UNAVAILABLE, locale),
      );
    }

    const materialsResult = await withTenantTx(database, tenantFrom(c), (tx) =>
      validateExamMaterials(tx, body.materialIds),
    );
    if (materialsResult.status === "not_found") {
      throw new CodedHttpException(
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        getLocalizedMessage(ERROR_CODES.RESOURCE_NOT_FOUND, locale),
      );
    }
    if (materialsResult.status === "not_ready") {
      throw new CodedHttpException(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        getLocalizedMessage(ERROR_CODES.VALIDATION_FAILED, locale),
      );
    }

    const routed = resolveAiModel("exam", modelOverrides);
    const questionCount = body.questionCount ?? AI_EXAM_DEFAULT_QUESTIONS;
    const questionTypes: ExamItemType[] = body.questionTypes ?? [...EXAM_ITEM_TYPES];
    const durationMinutes = body.durationMinutes ?? AI_EXAM_DEFAULT_DURATION_MINUTES;

    const session = await withTenantTx(database, tenantFrom(c), (tx) =>
      createExamSession(tx, {
        schoolId: auth.schoolId,
        studentId,
        model: routed.model,
        tier: routed.tier,
        questionCount,
        durationMinutes,
      }),
    );

    try {
      await queue.add(
        JOB_NAMES.GENERATE_EXAM,
        {
          version: 1,
          examSessionId: session.id,
          schoolId: auth.schoolId,
          studentId,
          materialIds: body.materialIds,
          questionCount,
          questionTypes,
          model: routed.model,
          tier: routed.tier,
          maxTokens: examMaxTokens(questionCount),
        },
        { ...EXAM_GENERATION_JOB_OPTIONS, jobId: session.id },
      );
    } catch (error) {
      c.get("log")?.warn(
        {
          err: error,
          school_id: auth.schoolId,
          student_id: studentId,
          exam_session_id: session.id,
        },
        "failed to enqueue exam generation",
      );
      await withTenantTx(database, tenantFrom(c), (tx) =>
        failExamSessionEnqueue(tx, {
          examSessionId: session.id,
          schoolId: auth.schoolId,
          reason: "failed to enqueue generation",
        }),
      );
      throw new CodedHttpException(
        503,
        ERROR_CODES.AI_EXAM_GENERATION_UNAVAILABLE,
        getLocalizedMessage(ERROR_CODES.AI_EXAM_GENERATION_UNAVAILABLE, locale),
      );
    }

    // Charged in full at create time; see config.ts's AI_EXAM_MAX_RESERVE_TOKENS for why.
    await quota.commit(AI_EXAM_MAX_RESERVE_TOKENS);

    return c.json(
      toExamSessionResponse(
        {
          id: session.id,
          status: "generating",
          model: routed.model,
          tier: routed.tier,
          questionCount,
          durationMinutes,
          startedAt: null,
          expiresAt: null,
          submittedAt: null,
          correctCount: null,
          inputTokens: null,
          outputTokens: null,
          failureReason: null,
          createdAt: session.createdAt,
        },
        studentId,
        null,
        null,
      ),
      202,
    );
  });

  routes.openapi(getExamRoute, async (c) => {
    const { studentId, examId } = c.req.valid("param");
    const quota = getAiQuota(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;
    const tenant = tenantFrom(c);

    const result = await withTenantTx(database, tenant, async (tx) => {
      const session = await loadExamSession(tx, {
        examSessionId: examId,
        schoolId: tenant.schoolId,
        studentId,
      });
      if (!session) return null;

      const items =
        session.status === "in_progress"
          ? await loadExamItems(tx, { examSessionId: examId, schoolId: tenant.schoolId })
          : null;
      const report =
        session.status === "submitted"
          ? await loadExamReport(tx, { examSessionId: examId, schoolId: tenant.schoolId })
          : null;
      return { session, items, report };
    });

    // No LLM call was made; the reservation is settled at zero, the same posture quiz grading uses.
    await quota.commit(0);

    if (!result) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.AI_EXAM_NOT_FOUND,
        getLocalizedMessage(ERROR_CODES.AI_EXAM_NOT_FOUND, locale),
      );
    }

    return c.json(
      toExamSessionResponse(result.session, studentId, result.items, result.report),
      200,
    );
  });

  routes.openapi(startExamRoute, async (c) => {
    const { studentId, examId } = c.req.valid("param");
    const quota = getAiQuota(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;
    const tenant = tenantFrom(c);

    const outcome = await withTenantTx(database, tenant, async (tx) => {
      const started = await startExamSession(tx, {
        examSessionId: examId,
        schoolId: tenant.schoolId,
      });
      if (!started) {
        const existing = await loadExamSession(tx, {
          examSessionId: examId,
          schoolId: tenant.schoolId,
          studentId,
        });
        return { ok: false as const, notFound: !existing };
      }
      const session = await loadExamSession(tx, {
        examSessionId: examId,
        schoolId: tenant.schoolId,
        studentId,
      });
      const items = await loadExamItems(tx, { examSessionId: examId, schoolId: tenant.schoolId });
      return { ok: true as const, session: session!, items };
    });

    await quota.commit(0);

    if (!outcome.ok) {
      if (outcome.notFound) {
        throw new CodedHttpException(
          404,
          ERROR_CODES.AI_EXAM_NOT_FOUND,
          getLocalizedMessage(ERROR_CODES.AI_EXAM_NOT_FOUND, locale),
        );
      }
      throw new CodedHttpException(
        409,
        ERROR_CODES.AI_EXAM_INVALID_STATE,
        getLocalizedMessage(ERROR_CODES.AI_EXAM_INVALID_STATE, locale),
      );
    }

    return c.json(toExamSessionResponse(outcome.session, studentId, outcome.items, null), 200);
  });

  routes.openapi(submitExamRoute, async (c) => {
    const { studentId, examId } = c.req.valid("param");
    const body = c.req.valid("json");
    const quota = getAiQuota(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;
    const tenant = tenantFrom(c);

    const outcome = await withTenantTx(database, tenant, async (tx) => {
      const session = await loadExamSession(tx, {
        examSessionId: examId,
        schoolId: tenant.schoolId,
        studentId,
      });
      if (!session) return { kind: "not_found" as const };
      if (session.status !== "in_progress") return { kind: "invalid_state" as const };
      // Server-side timer enforcement: the client's clock is never trusted, and the client cannot
      // extend expires_at through any request it controls.
      if (session.expiresAt !== null && new Date() > session.expiresAt) {
        return { kind: "expired" as const };
      }

      const items = await loadExamItemsForGrading(tx, {
        examSessionId: examId,
        schoolId: tenant.schoolId,
      });
      const itemIds = new Set(items.map((item) => item.id));
      const foreignAnswer = body.answers.find((answer) => !itemIds.has(answer.item_id));
      if (foreignAnswer) return { kind: "foreign_answer" as const };

      const graded = gradeExam(
        items.map((item) => ({
          id: item.id,
          type: item.type,
          correctOptionId: item.correctOptionId,
          correctAnswer: item.correctAnswer,
        })),
        body.answers.map((answer) => ({ itemId: answer.item_id, answer: answer.answer })),
      );

      const settled = await submitExamAnswers(tx, {
        examSessionId: examId,
        schoolId: tenant.schoolId,
        answers: graded.results.map((result) => ({
          itemId: result.itemId,
          submittedAnswer: result.submittedAnswer,
          isCorrect: result.correct,
        })),
        correctCount: graded.correctCount,
      });
      // Lost the race against a concurrent submit/expiry between the read above and this write.
      if (!settled) return { kind: "invalid_state" as const };

      const report = await loadExamReport(tx, { examSessionId: examId, schoolId: tenant.schoolId });
      const settledSession = await loadExamSession(tx, {
        examSessionId: examId,
        schoolId: tenant.schoolId,
        studentId,
      });
      return { kind: "ok" as const, session: settledSession!, report };
    });

    // No LLM call was made; the reservation is settled at zero, the same posture quiz grading uses.
    await quota.commit(0);

    if (outcome.kind === "not_found") {
      throw new CodedHttpException(
        404,
        ERROR_CODES.AI_EXAM_NOT_FOUND,
        getLocalizedMessage(ERROR_CODES.AI_EXAM_NOT_FOUND, locale),
      );
    }
    if (outcome.kind === "invalid_state") {
      throw new CodedHttpException(
        409,
        ERROR_CODES.AI_EXAM_INVALID_STATE,
        getLocalizedMessage(ERROR_CODES.AI_EXAM_INVALID_STATE, locale),
      );
    }
    if (outcome.kind === "expired") {
      throw new CodedHttpException(
        409,
        ERROR_CODES.AI_EXAM_EXPIRED,
        getLocalizedMessage(ERROR_CODES.AI_EXAM_EXPIRED, locale),
      );
    }
    if (outcome.kind === "foreign_answer") {
      throw new CodedHttpException(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        getLocalizedMessage(ERROR_CODES.VALIDATION_FAILED, locale),
      );
    }

    return c.json(toExamSessionResponse(outcome.session, studentId, null, outcome.report), 200);
  });

  return routes;
}
