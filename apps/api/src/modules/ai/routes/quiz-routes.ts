import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  AI_LLM_RETRY_AFTER_SECONDS,
  AI_QUIZ_ANSWER_MAX_CHARS,
  AI_QUIZ_DEFAULT_QUESTIONS,
  AI_QUIZ_MAX_MATERIALS,
  AI_QUIZ_MAX_QUESTIONS,
  AI_QUIZ_MIN_QUESTIONS,
  AI_QUIZ_OUTPUT_TOKEN_BUFFER,
  AI_QUIZ_OUTPUT_TOKENS_CEILING,
  AI_QUIZ_OUTPUT_TOKENS_PER_QUESTION,
} from "../config";
import { getAiQuota } from "../gate/entitlement-gate";
import { throwLlmError } from "../llm/errors";
import { AI_FEATURES, AI_MODEL_TIERS, resolveAiModel } from "../llm/routing";
import { gradeQuiz } from "../quiz/grading";
import { loadQuizMaterials } from "../quiz/materials";
import { parseQuizGeneration, QuizGenerationInvalidError } from "../quiz/parser";
import { loadQuizForGrading, persistQuiz } from "../quiz/persistence";
import { assembleQuizPrompt, toQuizSources } from "../quiz/prompt";
import { QUIZ_QUESTION_TYPES } from "../quiz/schema";
import { recordDurableUsage, splitByTier } from "../usage/durable";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { LlmProvider } from "../llm/provider";
import type { AiModelTier } from "../llm/routing";
import type { PersistedQuestionCitation, PersistedQuizQuestion } from "../quiz/persistence";
import type { QuizQuestionType } from "../quiz/schema";
import type { Context } from "hono";

/**
 * Quiz generation and grading (ST-167): `POST /api/ai/students/{studentId}/quizzes` and
 * `POST /api/ai/students/{studentId}/quizzes/{quizId}/grade`.
 *
 * Generation grounds a mix of MCQ and short-answer questions in the ingested text of one or more
 * materials (the same hardened source-block prompting `ask/prompt.ts` and `summary/prompt.ts` use),
 * validates the model's JSON response against the quiz schema (`quiz/schema.ts` via
 * `quiz/parser.ts`) before anything is persisted, and returns each question's prompt, options, and
 * citation -- but never its correct answer. The answer key lives only in `app.quiz_questions`
 * (migration 000099) until a grading request reveals it.
 *
 * Grading re-reads that stored answer key and scores the submission with a pure function
 * (`quiz/grading.ts`): no model call, so the same answers always produce the same score. It draws no
 * LLM tokens and commits zero to quota -- only generation is quota-metered, per the ST-167
 * acceptance criteria -- but still runs under the ST-155 gate (entitlement, not spend) like every
 * other `/api/ai/*` route.
 *
 * ## Error surface
 *
 * Generation: the shared ST-155 gate 403/402/429; a null provider -> 503 AI_LLM_DISABLED; a material
 * the student's school cannot see or that has no ingested text -> 404 RESOURCE_NOT_FOUND; a material
 * still mid-ingestion -> 422 VALIDATION_FAILED; the shared provider failure taxonomy (503
 * AI_LLM_UNAVAILABLE / AI_LLM_REQUEST_REJECTED); a model response that fails schema validation or
 * cites a source that was never given to it -> 503 AI_QUIZ_GENERATION_FAILED with Retry-After, and
 * -- deliberately, see config.ts -- not committed to quota, the same posture a transport failure
 * already gets.
 *
 * Grading: a quiz that does not exist, or belongs to a different student -> 404 AI_QUIZ_NOT_FOUND; an
 * answer naming a question id outside the quiz -> 422 VALIDATION_FAILED.
 */

const QUIZ_FEATURE: (typeof AI_FEATURES)[number] = "quiz";

// ---------------------------------------------------------------------------------------------------
// Shared response shapes
// ---------------------------------------------------------------------------------------------------

const quizOptionSchema = z.object({
  id: z.string(),
  text: z.string(),
});

const quizCitationSchema = z.object({
  /** `app.material_chunks.id` this question was grounded on. */
  chunk_id: z.string().uuid(),
  material_id: z.string().uuid(),
  material_title: z.string().nullable(),
  page_number: z.number().int().nullable(),
  section_title: z.string().nullable(),
});

function citationAnchor(citation: PersistedQuestionCitation) {
  return {
    chunk_id: citation.chunkId,
    material_id: citation.materialId,
    material_title: citation.materialTitle,
    page_number: citation.pageNumber,
    section_title: citation.sectionTitle,
  };
}

// ---------------------------------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------------------------------

const quizUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

const quizQuestionResponseSchema = z.object({
  id: z.string().uuid(),
  /** The question's 1-based position within the quiz. */
  order: z.number().int().min(1),
  type: z.enum(QUIZ_QUESTION_TYPES),
  prompt: z.string(),
  /** The choices for an `mcq` question, in generation order. Null for `short_answer`. Never reveals which is correct. */
  options: z.array(quizOptionSchema).nullable(),
  citation: quizCitationSchema,
});

const generateQuizResponseSchema = z.object({
  quiz_id: z.string().uuid(),
  model: z.string(),
  tier: z.enum(AI_MODEL_TIERS),
  feature: z.enum(AI_FEATURES),
  question_count: z.number().int().min(1),
  usage: quizUsageSchema,
  questions: z.array(quizQuestionResponseSchema),
});

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

const generateQuizBodySchema = z.object({
  materialIds: z
    .array(z.string().uuid())
    .min(1)
    .max(AI_QUIZ_MAX_MATERIALS)
    .refine((ids) => !hasDuplicates(ids), { message: "materialIds must not contain duplicates" })
    .openapi({
      description: `The materials to generate the quiz from, up to ${AI_QUIZ_MAX_MATERIALS}.`,
      example: ["0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12"],
    }),
  questionCount: z
    .number()
    .int()
    .min(AI_QUIZ_MIN_QUESTIONS)
    .max(AI_QUIZ_MAX_QUESTIONS)
    .optional()
    .openapi({
      description: `How many questions to generate. Defaults to ${AI_QUIZ_DEFAULT_QUESTIONS}, up to ${AI_QUIZ_MAX_QUESTIONS}.`,
      example: 5,
    }),
  questionTypes: z
    .array(z.enum(QUIZ_QUESTION_TYPES))
    .min(1)
    .max(QUIZ_QUESTION_TYPES.length)
    .refine((types) => !hasDuplicates(types), {
      message: "questionTypes must not contain duplicates",
    })
    .optional()
    .openapi({
      description: "Which question types to mix. Defaults to both mcq and short_answer.",
      example: ["mcq", "short_answer"],
    }),
});

const quizStudentParamsSchema = z.object({
  studentId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "studentId", in: "path" },
      description: "The student whose AI quota the quiz draws on.",
    }),
});

const generateQuizRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/quizzes",
  tags: ["AI"],
  operationId: "generateQuiz",
  summary: "Generate an MCQ / short-answer quiz from selected materials",
  description:
    "Loads the selected materials' ingested text chunks, routes generation through the large " +
    "(reasoning) model tier, and validates the model's response against the quiz schema before " +
    "persisting it -- a response with malformed options, or that cites a source it was never " +
    "given, is rejected rather than stored. Every question carries a citation to the single " +
    "material chunk it was grounded on. The answer key is never included in this response; call " +
    "the grading endpoint to score a submission and reveal it. Consumes the same gate as every " +
    "other AI surface (403/402/429). Refuses with 404 RESOURCE_NOT_FOUND for a material the school " +
    "cannot see or with no ingested text, 422 VALIDATION_FAILED while a material is still " +
    "mid-ingestion, 503 AI_LLM_DISABLED when the LLM plane is off, 503 AI_QUIZ_GENERATION_FAILED " +
    "when the model's output does not validate, and the shared provider failure taxonomy (503 " +
    "AI_LLM_UNAVAILABLE with Retry-After / 503 AI_LLM_REQUEST_REJECTED).",
  security: [{ bearerAuth: [] }],
  request: {
    params: quizStudentParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: generateQuizBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The generated quiz: every question's prompt, options, and citation.",
        schema: generateQuizResponseSchema,
      },
    },
    [400, 401, 402, 403, 404, 422, 429, 500, 503],
  ),
});

// ---------------------------------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------------------------------

const gradeAnswerSchema = z.object({
  question_id: z.string().uuid(),
  answer: z.string().trim().min(1).max(AI_QUIZ_ANSWER_MAX_CHARS),
});

const gradeQuizBodySchema = z.object({
  /** Unanswered questions are graded wrong; omit them rather than sending an empty string. */
  answers: z.array(gradeAnswerSchema).max(AI_QUIZ_MAX_QUESTIONS),
});

const gradeQuizParamsSchema = quizStudentParamsSchema.extend({
  quizId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "quizId", in: "path" },
      description: "The quiz to grade, as returned by the generate endpoint.",
    }),
});

const gradeResultSchema = z.object({
  question_id: z.string().uuid(),
  correct: z.boolean(),
  /** What the student submitted, or null when they left this question unanswered. */
  your_answer: z.string().nullable(),
  /** The answer key, revealed now that grading has happened. */
  correct_answer: z.string(),
  citation: quizCitationSchema,
});

const gradeQuizResponseSchema = z.object({
  quiz_id: z.string().uuid(),
  correct_count: z.number().int().nonnegative(),
  total_questions: z.number().int().nonnegative(),
  /** Rounded to the nearest whole percent. */
  percentage: z.number().int().min(0).max(100),
  results: z.array(gradeResultSchema),
});

const gradeQuizRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/quizzes/{quizId}/grade",
  tags: ["AI"],
  operationId: "gradeQuiz",
  summary: "Grade a quiz submission with instant feedback",
  description:
    "Scores a quiz submission against its stored answer key: MCQ by exact option-id match, " +
    "short-answer by normalized string equality (trim, casefold, collapse whitespace) -- " +
    "deterministic, not semantic. A question with no submitted answer is graded wrong, not " +
    "skipped. Draws no LLM tokens and is not quota-metered, unlike generation. Refuses with 404 " +
    "AI_QUIZ_NOT_FOUND for a quiz that does not exist or belongs to a different student, and 422 " +
    "VALIDATION_FAILED for an answer naming a question id outside the quiz.",
  security: [{ bearerAuth: [] }],
  request: {
    params: gradeQuizParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: gradeQuizBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The score and per-question feedback, with the answer key revealed.",
        schema: gradeQuizResponseSchema,
      },
    },
    [400, 401, 402, 403, 404, 422, 429, 500, 503],
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

function questionAnchor(question: PersistedQuizQuestion) {
  return {
    id: question.id,
    order: question.order,
    type: question.type,
    prompt: question.prompt,
    options: question.options,
    citation: citationAnchor(question.citation),
  };
}

/** `questionCount` scaled by an estimated per-question cost -- see config.ts for the reserve math. */
function quizMaxTokens(questionCount: number): number {
  return Math.min(
    AI_QUIZ_OUTPUT_TOKENS_CEILING,
    questionCount * AI_QUIZ_OUTPUT_TOKENS_PER_QUESTION + AI_QUIZ_OUTPUT_TOKEN_BUFFER,
  );
}

export function aiQuizRoutes(deps: {
  database: Database;
  /**
   * The configured LLM provider, or null when the AI_LLM_ENABLED kill switch is off. Null answers
   * 503 AI_LLM_DISABLED at request time; the route still registers so the published contract does
   * not depend on a deployment's environment (the storage-upload precedent).
   */
  provider: LlmProvider | null;
  /** Environment overrides for the routing table's model ids (`AI_LLM_LARGE_MODEL`). */
  modelOverrides?: Partial<Record<AiModelTier, string>>;
}): OpenAPIHono<AppEnv> {
  const { database, provider, modelOverrides = {} } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // The audit-coverage gate (tests/audit-coverage.test.ts) requires every mutating route to declare
  // its audit intent. Generation's writes are app.quizzes, app.quiz_questions, and the durable usage
  // meter. Grading writes nothing -- it reads the persisted answer key and scores in memory -- so
  // "read" is the accurate declaration rather than borrowing a write verb that did not happen.
  routes.use("/api/ai/students/{studentId}/quizzes", auditAction("insert", "quiz_questions"));
  routes.use(
    "/api/ai/students/{studentId}/quizzes/{quizId}/grade",
    auditAction("read", "quiz_questions"),
  );

  routes.openapi(generateQuizRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const quota = getAiQuota(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;

    if (!provider) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.AI_LLM_DISABLED,
        getLocalizedMessage(ERROR_CODES.AI_LLM_DISABLED, locale),
      );
    }

    const routed = resolveAiModel("quiz", modelOverrides);
    const questionCount = body.questionCount ?? AI_QUIZ_DEFAULT_QUESTIONS;
    const questionTypes: QuizQuestionType[] = body.questionTypes ?? [...QUIZ_QUESTION_TYPES];

    const loaded = await withTenantTx(database, tenantFrom(c), (tx) =>
      loadQuizMaterials(tx, body.materialIds),
    );

    if (loaded.status === "not_found") {
      throw new CodedHttpException(
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        getLocalizedMessage(ERROR_CODES.RESOURCE_NOT_FOUND, locale),
      );
    }
    if (loaded.status === "not_ready") {
      throw new CodedHttpException(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        getLocalizedMessage(ERROR_CODES.VALIDATION_FAILED, locale),
      );
    }
    if (loaded.chunks.length === 0) {
      throw new CodedHttpException(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        getLocalizedMessage(ERROR_CODES.VALIDATION_FAILED, locale),
      );
    }

    const sources = toQuizSources(loaded.chunks);
    const prompt = assembleQuizPrompt(sources, questionCount, questionTypes);

    try {
      const generation = await provider.generate({
        model: routed.model,
        prompt: prompt.user,
        system: prompt.system,
        maxTokens: quizMaxTokens(questionCount),
        userId: auth.userId,
        circuitKey: auth.schoolId,
      });

      // Malformed model output is rejected here, before anything is persisted or any tokens are
      // committed -- see config.ts for why this does not retry server-side.
      const questions = parseQuizGeneration(generation.content, sources.length);

      // The provider call deliberately happened outside the transaction above; this short write is
      // all the transaction holds.
      const persisted = await withTenantTx(database, tenantFrom(c), async (tx) => {
        await recordDurableUsage(
          tx,
          auth.schoolId,
          studentId,
          splitByTier(generation.usage.totalTokens, routed.tier),
        );
        return persistQuiz(tx, {
          schoolId: auth.schoolId,
          studentId,
          model: generation.model,
          questions,
          sources,
        });
      });

      await quota.commit(generation.usage.totalTokens);

      return c.json(
        {
          quiz_id: persisted.quizId,
          model: generation.model,
          tier: routed.tier,
          feature: QUIZ_FEATURE,
          question_count: persisted.questions.length,
          usage: generation.usage,
          questions: persisted.questions.map(questionAnchor),
        },
        200,
      );
    } catch (error) {
      if (error instanceof QuizGenerationInvalidError) {
        c.get("log")?.warn(
          { err: error, school_id: auth.schoolId, student_id: studentId },
          "quiz generation output failed schema validation",
        );
        c.header("Retry-After", String(AI_LLM_RETRY_AFTER_SECONDS));
        throw new CodedHttpException(
          503,
          ERROR_CODES.AI_QUIZ_GENERATION_FAILED,
          getLocalizedMessage(ERROR_CODES.AI_QUIZ_GENERATION_FAILED, locale),
        );
      }
      throwLlmError(c, error);
    }
  });

  routes.openapi(gradeQuizRoute, async (c) => {
    const { studentId, quizId } = c.req.valid("param");
    const body = c.req.valid("json");
    const quota = getAiQuota(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;

    const loaded = await withTenantTx(database, tenantFrom(c), (tx) =>
      loadQuizForGrading(tx, { quizId, studentId }),
    );

    if (!loaded) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.AI_QUIZ_NOT_FOUND,
        getLocalizedMessage(ERROR_CODES.AI_QUIZ_NOT_FOUND, locale),
      );
    }

    const questionIds = new Set(loaded.questions.map((question) => question.id));
    const foreignAnswer = body.answers.find((answer) => !questionIds.has(answer.question_id));
    if (foreignAnswer) {
      throw new CodedHttpException(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        getLocalizedMessage(ERROR_CODES.VALIDATION_FAILED, locale),
      );
    }

    const graded = gradeQuiz(
      loaded.questions.map((question) => ({
        id: question.id,
        type: question.type,
        correctOptionId: question.correctOptionId,
        correctAnswer: question.correctAnswer,
      })),
      body.answers.map((answer) => ({ questionId: answer.question_id, answer: answer.answer })),
    );

    // No LLM call was made; the reservation is settled at zero, the same posture the summarizer's
    // cache-hit path uses.
    await quota.commit(0);

    const citationById = new Map(
      loaded.questions.map((question) => [question.id, question.citation]),
    );

    return c.json(
      {
        quiz_id: loaded.quizId,
        correct_count: graded.correctCount,
        total_questions: graded.totalQuestions,
        percentage: graded.percentage,
        results: graded.results.map((result) => ({
          question_id: result.questionId,
          correct: result.correct,
          your_answer: result.submittedAnswer,
          correct_answer: result.correctAnswer,
          citation: citationAnchor(citationById.get(result.questionId)!),
        })),
      },
      200,
    );
  });

  return routes;
}
