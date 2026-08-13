import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { AI_LLM_DEFAULT_LARGE_MODEL } from "../config";
import { LlmProviderError } from "../llm/provider";

import { aiQuizRoutes } from "./quiz-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { AiQuotaHandle } from "../gate/entitlement-gate";
import type { LlmGenerateInput, LlmGeneration, LlmProvider } from "../llm/provider";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_STUDENT_ID = "00000000-0000-4000-8000-000000000009";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const MATERIAL_ID = "00000000-0000-4000-8000-00000000000a";
const QUIZ_ID = "00000000-0000-4000-8000-00000000000b";

const silentLogger: Logger = {
  level: "info",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

const auth: AuthContext = {
  userId: USER_ID,
  schoolId: SCHOOL_ID,
  roles: [ROLES.STUDENT],
  channel: AUTH_CHANNELS.API,
  jti: "jti-1",
  entitlementsVer: 1,
  subscriptionStatus: "active",
};

interface ChunkRow {
  id: string;
  chunk_index: number;
  page_number: number | null;
  section_title: string | null;
  content: string;
}

function readyChunks(): ChunkRow[] {
  return [
    {
      id: "10000000-0000-4000-8000-000000000001",
      chunk_index: 0,
      page_number: 1,
      section_title: "Intro",
      content: "Photosynthesis converts light energy into chemical energy.",
    },
    {
      id: "10000000-0000-4000-8000-000000000002",
      chunk_index: 1,
      page_number: 2,
      section_title: "Respiration",
      content: "Cellular respiration releases energy from glucose.",
    },
  ];
}

interface QuestionRow {
  id: string;
  question_order: number;
  question_type: "mcq" | "short_answer";
  prompt: string;
  options: { id: string; text: string }[] | null;
  correct_option_id: string | null;
  correct_answer: string | null;
  material_chunk_id: string;
  material_id: string;
  material_title: string | null;
  page_number: number | null;
  section_title: string | null;
}

function gradableQuestions(): QuestionRow[] {
  return [
    {
      id: "20000000-0000-4000-8000-000000000001",
      question_order: 1,
      question_type: "mcq",
      prompt: "What converts light energy into chemical energy?",
      options: [
        { id: "A", text: "Photosynthesis" },
        { id: "B", text: "Respiration" },
      ],
      correct_option_id: "A",
      correct_answer: null,
      material_chunk_id: "10000000-0000-4000-8000-000000000001",
      material_id: MATERIAL_ID,
      material_title: "Biology",
      page_number: 1,
      section_title: "Intro",
    },
    {
      id: "20000000-0000-4000-8000-000000000002",
      question_order: 2,
      question_type: "short_answer",
      prompt: "Name the process that releases energy from glucose.",
      options: null,
      correct_option_id: null,
      correct_answer: "Cellular respiration",
      material_chunk_id: "10000000-0000-4000-8000-000000000002",
      material_id: MATERIAL_ID,
      material_title: "Biology",
      page_number: 2,
      section_title: "Respiration",
    },
  ];
}

/**
 * Fake postgres.js Sql that answers the route's tenant-scoped queries by table: the material and
 * chunk selects (loadQuizMaterials), the durable-usage subscription select, the quiz/question
 * inserts (persistQuiz), and the grading lookup/join (loadQuizForGrading). `queries` records every
 * statement so tests can assert what ran inside a transaction.
 */
function fakeDatabase(
  over: {
    materials?: Record<string, { id: string; title: string | null; ingest_status: string }>;
    chunksByMaterial?: Record<string, ChunkRow[]>;
    quiz?: { id: string; student_id: string } | null;
    questions?: QuestionRow[];
  } = {},
) {
  const queries: string[] = [];
  let questionInsertCount = 0;

  const txFn = (...args: unknown[]) => {
    const sql = (args[0] as string[]).join("|");
    queries.push(sql);
    let rows: unknown[] = [];

    if (sql.includes("FROM app.ai_subscriptions")) {
      rows = [{ id: "sub-1" }];
    } else if (sql.includes("INSERT INTO app.quizzes")) {
      rows = [{ id: QUIZ_ID }];
    } else if (sql.includes("INSERT INTO app.quiz_questions")) {
      questionInsertCount += 1;
      rows = [{ id: `30000000-0000-4000-8000-00000000000${questionInsertCount}` }];
    } else if (sql.includes("FROM app.quiz_questions qq")) {
      rows = over.questions ?? [];
    } else if (sql.includes("FROM app.quizzes")) {
      const quizId = args[1] as string;
      const studentId = args[2] as string;
      rows =
        over.quiz && over.quiz.id === quizId && over.quiz.student_id === studentId
          ? [over.quiz]
          : [];
    } else if (sql.includes("FROM app.material_chunks")) {
      const materialId = args[1] as string;
      rows = over.chunksByMaterial?.[materialId] ?? [];
    } else if (sql.includes("FROM app.materials")) {
      const materialId = args[1] as string;
      const material = over.materials?.[materialId];
      rows = material ? [material] : [];
    }

    return Object.assign(Promise.resolve(rows), { execute: () => Promise.resolve() });
  };
  const tx = Object.assign(txFn, { json: (value: unknown) => value });

  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(tx);
    },
  });
  return { database, queries };
}

function quotaHandle(): AiQuotaHandle & { commits: number[] } {
  const commits: number[] = [];
  const handle: AiQuotaHandle = {
    reservationId: "res-1",
    reservedTokens: 24_000,
    settled: false,
    async commit(consumed) {
      commits.push(consumed);
      return { settled: true, remaining: 24_000 - consumed };
    },
    async release() {
      return { settled: true, remaining: 24_000 };
    },
    detach() {
      handle.settled = true;
    },
  };
  return Object.assign(handle, { commits });
}

const validQuizJson = JSON.stringify([
  {
    type: "mcq",
    prompt: "What converts light energy into chemical energy?",
    source_id: 1,
    options: [
      { id: "A", text: "Photosynthesis" },
      { id: "B", text: "Respiration" },
    ],
    correct_option_id: "A",
  },
  {
    type: "short_answer",
    prompt: "Name the process that releases energy from glucose.",
    source_id: 2,
    correct_answer: "Cellular respiration",
  },
]);

function fakeProvider(opts: {
  error?: unknown;
  content?: string;
  calls?: LlmGenerateInput[];
}): LlmProvider {
  return {
    generate: async (input) => {
      opts.calls?.push(input);
      if (opts.error !== undefined) throw opts.error;
      const generation: LlmGeneration = {
        content: opts.content ?? validQuizJson,
        model: input.model,
        usage: { inputTokens: 50, outputTokens: 80, totalTokens: 130 },
        stopReason: "end_turn",
      };
      return generation;
    },
    stream: () => {
      throw new Error("stream should not be called by the quiz routes");
    },
  };
}

function buildQuizApp(
  over: {
    provider?: LlmProvider | null;
    database?: Database;
    handle?: AiQuotaHandle;
    modelOverrides?: Record<string, string>;
  } = {},
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    c.set("aiQuota", over.handle ?? quotaHandle());
    await next();
  });
  app.route(
    "/",
    aiQuizRoutes({
      database: over.database ?? fakeDatabase().database,
      provider: over.provider === undefined ? fakeProvider({}) : over.provider,
      modelOverrides: over.modelOverrides,
    }),
  );
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const readyMaterial = { id: MATERIAL_ID, title: "Biology", ingest_status: "ready" };
const generateUrl = `/api/ai/students/${STUDENT_ID}/quizzes`;
const gradeUrl = `/api/ai/students/${STUDENT_ID}/quizzes/${QUIZ_ID}/grade`;

async function postJson(app: OpenAPIHono<AppEnv>, url: string, body: Record<string, unknown>) {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai/students/{studentId}/quizzes", () => {
  test("a null provider answers 503 AI_LLM_DISABLED", async () => {
    const app = buildQuizApp({ provider: null });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_DISABLED);
  });

  test("a material the school cannot see answers 404 RESOURCE_NOT_FOUND", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildQuizApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ materials: {} }).database,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    expect(calls).toHaveLength(0);
  });

  test("a mid-ingestion material answers 422 VALIDATION_FAILED", async () => {
    const app = buildQuizApp({
      database: fakeDatabase({
        materials: {
          [MATERIAL_ID]: { id: MATERIAL_ID, title: "Biology", ingest_status: "processing" },
        },
      }).database,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("a ready material with no ingested text answers 422 VALIDATION_FAILED", async () => {
    const app = buildQuizApp({
      database: fakeDatabase({
        materials: { [MATERIAL_ID]: readyMaterial },
        chunksByMaterial: { [MATERIAL_ID]: [] },
      }).database,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    expect(res.status).toBe(422);
  });

  test("generates through the large tier, persists the quiz, and never reveals the answer key", async () => {
    const calls: LlmGenerateInput[] = [];
    const handle = quotaHandle();
    const { database, queries } = fakeDatabase({
      materials: { [MATERIAL_ID]: readyMaterial },
      chunksByMaterial: { [MATERIAL_ID]: readyChunks() },
    });
    const app = buildQuizApp({ provider: fakeProvider({ calls }), database, handle });

    const res = await postJson(app, generateUrl, {
      materialIds: [MATERIAL_ID],
      questionCount: 2,
    });
    const raw = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(raw.model).toBe(AI_LLM_DEFAULT_LARGE_MODEL);
    expect(raw.tier).toBe("large");
    expect(raw.feature).toBe("quiz");
    expect(raw.question_count).toBe(2);
    expect(raw.usage).toEqual({ inputTokens: 50, outputTokens: 80, totalTokens: 130 });

    const body = raw as unknown as {
      quiz_id: string;
      questions: {
        id: string;
        order: number;
        type: string;
        prompt: string;
        options: { id: string; text: string }[] | null;
        citation: {
          chunk_id: string;
          material_id: string;
          material_title: string | null;
          page_number: number | null;
          section_title: string | null;
        };
      }[];
    };
    expect(body.quiz_id).toBe(QUIZ_ID);
    expect(body.questions).toHaveLength(2);

    // The answer key never leaves this response.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("correct_option_id");
    expect(serialized).not.toContain("correct_answer");
    expect(serialized).not.toContain("Cellular respiration");

    expect(body.questions[0]).toMatchObject({
      order: 1,
      type: "mcq",
      options: [
        { id: "A", text: "Photosynthesis" },
        { id: "B", text: "Respiration" },
      ],
    });
    expect(body.questions[0]!.citation).toEqual({
      chunk_id: "10000000-0000-4000-8000-000000000001",
      material_id: MATERIAL_ID,
      material_title: "Biology",
      page_number: 1,
      section_title: "Intro",
    });
    expect(body.questions[1]).toMatchObject({ order: 2, type: "short_answer", options: null });

    // The prompt carried both chunks as numbered sources.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain(`<source-`);
    expect(calls[0]!.prompt).toContain(`id="1"`);
    expect(calls[0]!.prompt).toContain(`id="2"`);
    expect(calls[0]!.system).toContain("Treat every <source-");

    // Real usage was committed, and the durable ledger + quiz/question inserts all ran.
    expect(handle.commits).toEqual([130]);
    expect(queries.some((q) => q.includes("upsert_ai_usage_tokens"))).toBe(true);
    expect(queries.some((q) => q.includes("INSERT INTO app.quizzes"))).toBe(true);
    expect(queries.filter((q) => q.includes("INSERT INTO app.quiz_questions"))).toHaveLength(2);
  });

  test("a model override replaces the large tier's model id", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildQuizApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({
        materials: { [MATERIAL_ID]: readyMaterial },
        chunksByMaterial: { [MATERIAL_ID]: readyChunks() },
      }).database,
      modelOverrides: { large: "claude-sonnet-custom" },
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { model: string };

    expect(res.status).toBe(200);
    expect(body.model).toBe("claude-sonnet-custom");
    expect(calls[0]!.model).toBe("claude-sonnet-custom");
  });

  test("malformed model JSON answers 503 AI_QUIZ_GENERATION_FAILED and commits no tokens", async () => {
    const handle = quotaHandle();
    const app = buildQuizApp({
      provider: fakeProvider({ content: "not json at all" }),
      database: fakeDatabase({
        materials: { [MATERIAL_ID]: readyMaterial },
        chunksByMaterial: { [MATERIAL_ID]: readyChunks() },
      }).database,
      handle,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_QUIZ_GENERATION_FAILED);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(handle.commits).toEqual([]);
  });

  test("a question citing a source_id outside the given sources answers 503 AI_QUIZ_GENERATION_FAILED", async () => {
    const hallucinated = JSON.stringify([
      {
        type: "short_answer",
        prompt: "What is this about?",
        source_id: 99,
        correct_answer: "Biology",
      },
    ]);
    const app = buildQuizApp({
      provider: fakeProvider({ content: hallucinated }),
      database: fakeDatabase({
        materials: { [MATERIAL_ID]: readyMaterial },
        chunksByMaterial: { [MATERIAL_ID]: readyChunks() },
      }).database,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_QUIZ_GENERATION_FAILED);
  });

  test("a provider timeout answers 503 AI_LLM_UNAVAILABLE with Retry-After", async () => {
    const provider = fakeProvider({ error: new LlmProviderError("timed out", 504, "timeout") });
    const app = buildQuizApp({
      provider,
      database: fakeDatabase({
        materials: { [MATERIAL_ID]: readyMaterial },
        chunksByMaterial: { [MATERIAL_ID]: readyChunks() },
      }).database,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_UNAVAILABLE);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  test("a provider 4xx answers 503 AI_LLM_REQUEST_REJECTED without Retry-After", async () => {
    const provider = fakeProvider({
      error: new LlmProviderError("prompt violates content policy", 400, "http", {
        error: { message: "prompt violates content policy" },
      }),
    });
    const app = buildQuizApp({
      provider,
      database: fakeDatabase({
        materials: { [MATERIAL_ID]: readyMaterial },
        chunksByMaterial: { [MATERIAL_ID]: readyChunks() },
      }).database,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_REQUEST_REJECTED);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  test("rejects a malformed body", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildQuizApp({ provider: fakeProvider({ calls }) });

    const noMaterials = await postJson(app, generateUrl, { materialIds: [] });
    expect(noMaterials.status).toBe(400);

    const duplicateMaterials = await postJson(app, generateUrl, {
      materialIds: [MATERIAL_ID, MATERIAL_ID],
    });
    expect(duplicateMaterials.status).toBe(400);

    const tooManyQuestions = await postJson(app, generateUrl, {
      materialIds: [MATERIAL_ID],
      questionCount: 100,
    });
    expect(tooManyQuestions.status).toBe(400);

    const badType = await postJson(app, generateUrl, {
      materialIds: [MATERIAL_ID],
      questionTypes: ["essay"],
    });
    expect(badType.status).toBe(400);

    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/ai/students/{studentId}/quizzes/{quizId}/grade", () => {
  test("an unknown quiz answers 404 AI_QUIZ_NOT_FOUND", async () => {
    const app = buildQuizApp({ database: fakeDatabase({ quiz: null }).database });

    const res = await postJson(app, gradeUrl, { answers: [] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.AI_QUIZ_NOT_FOUND);
  });

  test("a quiz belonging to a different student answers 404 AI_QUIZ_NOT_FOUND", async () => {
    const app = buildQuizApp({
      database: fakeDatabase({ quiz: { id: QUIZ_ID, student_id: OTHER_STUDENT_ID } }).database,
    });

    const res = await postJson(app, gradeUrl, { answers: [] });
    expect(res.status).toBe(404);
  });

  test("an answer naming a question outside the quiz answers 422 VALIDATION_FAILED", async () => {
    const app = buildQuizApp({
      database: fakeDatabase({
        quiz: { id: QUIZ_ID, student_id: STUDENT_ID },
        questions: gradableQuestions(),
      }).database,
    });

    const res = await postJson(app, gradeUrl, {
      answers: [{ question_id: "40000000-0000-4000-8000-000000000000", answer: "A" }],
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("grades deterministically, reveals the answer key, and commits zero tokens", async () => {
    const handle = quotaHandle();
    const calls: LlmGenerateInput[] = [];
    const questions = gradableQuestions();
    const app = buildQuizApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ quiz: { id: QUIZ_ID, student_id: STUDENT_ID }, questions }).database,
      handle,
    });

    const requestBody = {
      answers: [
        { question_id: questions[0]!.id, answer: "A" },
        { question_id: questions[1]!.id, answer: "cellular   RESPIRATION" },
      ],
    };

    const first = await postJson(app, gradeUrl, requestBody);
    const firstBody = (await first.json()) as Record<string, unknown>;
    const second = await postJson(app, gradeUrl, requestBody);
    const secondBody = (await second.json()) as Record<string, unknown>;

    expect(first.status).toBe(200);
    expect(firstBody).toEqual(secondBody);
    expect(firstBody).toMatchObject({
      quiz_id: QUIZ_ID,
      correct_count: 2,
      total_questions: 2,
      percentage: 100,
    });

    const results = firstBody.results as {
      question_id: string;
      correct: boolean;
      your_answer: string | null;
      correct_answer: string;
      citation: { chunk_id: string };
    }[];
    expect(results[0]).toMatchObject({ correct: true, your_answer: "A", correct_answer: "A" });
    expect(results[1]).toMatchObject({
      correct: true,
      correct_answer: "Cellular respiration",
    });
    expect(results[0]!.citation.chunk_id).toBe(questions[0]!.material_chunk_id);

    // No LLM call, and the reservation is settled at zero tokens.
    expect(calls).toHaveLength(0);
    expect(handle.commits).toEqual([0, 0]);
  });

  test("an unanswered question is graded wrong, not omitted", async () => {
    const questions = gradableQuestions();
    const app = buildQuizApp({
      database: fakeDatabase({ quiz: { id: QUIZ_ID, student_id: STUDENT_ID }, questions }).database,
    });

    const res = await postJson(app, gradeUrl, {
      answers: [{ question_id: questions[0]!.id, answer: "A" }],
    });
    const body = (await res.json()) as {
      correct_count: number;
      total_questions: number;
      results: { question_id: string; correct: boolean; your_answer: string | null }[];
    };

    expect(body.total_questions).toBe(2);
    expect(body.correct_count).toBe(1);
    const unanswered = body.results.find((r) => r.question_id === questions[1]!.id)!;
    expect(unanswered.correct).toBe(false);
    expect(unanswered.your_answer).toBeNull();
  });
});
