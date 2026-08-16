import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";

import { aiExamRoutes } from "./exam-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { AiQuotaHandle } from "../gate/entitlement-gate";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const MATERIAL_ID = "00000000-0000-4000-8000-00000000000a";
const EXAM_ID = "00000000-0000-4000-8000-00000000000b";
const ITEM_1 = "20000000-0000-4000-8000-000000000001";
const ITEM_2 = "20000000-0000-4000-8000-000000000002";
const CHUNK_1 = "10000000-0000-4000-8000-000000000001";
const CHUNK_2 = "10000000-0000-4000-8000-000000000002";

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

interface SessionRow {
  id: string;
  status: string;
  model: string;
  tier: string;
  question_count: number;
  duration_minutes: number;
  started_at: Date | null;
  expires_at: Date | null;
  submitted_at: Date | null;
  correct_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  failure_reason: string | null;
  created_at: Date;
}

function baseSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: EXAM_ID,
    status: "ready",
    model: "claude-sonnet-4-20250514",
    tier: "large",
    question_count: 2,
    duration_minutes: 30,
    started_at: null,
    expires_at: null,
    submitted_at: null,
    correct_count: null,
    input_tokens: 500,
    output_tokens: 300,
    failure_reason: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

interface ItemRow {
  id: string;
  item_order: number;
  item_type: "mcq" | "short_answer";
  prompt: string;
  correct_option_id: string | null;
  correct_answer: string | null;
  material_chunk_id: string;
  material_id: string;
  material_title: string | null;
  page_number: number | null;
  section_title: string | null;
  options: { id: string; text: string }[] | null;
}

function gradableItems(): ItemRow[] {
  return [
    {
      id: ITEM_1,
      item_order: 1,
      item_type: "mcq",
      prompt: "What converts light energy into chemical energy?",
      correct_option_id: "A",
      correct_answer: null,
      material_chunk_id: CHUNK_1,
      material_id: MATERIAL_ID,
      material_title: "Biology",
      page_number: 1,
      section_title: "Intro",
      options: [
        { id: "A", text: "Photosynthesis" },
        { id: "B", text: "Respiration" },
      ],
    },
    {
      id: ITEM_2,
      item_order: 2,
      item_type: "short_answer",
      prompt: "Name the process that releases energy from glucose.",
      correct_option_id: null,
      correct_answer: "Cellular respiration",
      material_chunk_id: CHUNK_2,
      material_id: MATERIAL_ID,
      material_title: "Biology",
      page_number: 2,
      section_title: "Respiration",
      options: null,
    },
  ];
}

/**
 * Fake postgres.js Sql answering the exam routes' tenant-scoped queries by distinctive substring,
 * mirroring quiz-routes.test.ts's `fakeDatabase` dispatch style. Order matters: more specific
 * (INSERT/UPDATE) patterns are checked before the generic `FROM app.exam_sessions` SELECT.
 */
function fakeDatabase(
  over: {
    materials?: Record<string, { ingest_status: string }>;
    session?: SessionRow | null;
    items?: ItemRow[];
    answers?: { exam_item_id: string; is_correct: boolean }[];
  } = {},
) {
  const queries: string[] = [];
  const answerInserts: {
    school_id: string;
    exam_item_id: string;
    submitted_answer: string | null;
    is_correct: boolean;
  }[] = [];
  let session = over.session === undefined ? baseSession() : over.session;

  const txFn = (...args: unknown[]) => {
    const sql = (args[0] as string[]).join("|");
    queries.push(sql);
    let rows: unknown[] = [];

    if (sql.includes("SELECT ingest_status")) {
      const materialId = args[1] as string;
      const material = over.materials?.[materialId];
      rows = material ? [material] : [];
    } else if (sql.includes("INSERT INTO app.exam_sessions")) {
      rows = [{ id: EXAM_ID, created_at: baseSession().created_at }];
    } else if (sql.includes("SET status = 'failed'")) {
      if (session && session.status === "generating") session = { ...session, status: "failed" };
      rows = session ? [{ id: session.id }] : [];
    } else if (sql.includes("SET status = 'in_progress'")) {
      if (session && session.status === "ready") {
        session = {
          ...session,
          status: "in_progress",
          started_at: new Date("2026-01-01T00:00:00.000Z"),
          expires_at: new Date("2026-01-01T00:30:00.000Z"),
        };
        rows = [{ started_at: session.started_at, expires_at: session.expires_at }];
      }
    } else if (sql.includes("SET status = 'submitted'")) {
      const correctCount = args[1] as number;
      if (session && session.status === "in_progress") {
        session = {
          ...session,
          status: "submitted",
          submitted_at: new Date("2026-01-01T00:10:00.000Z"),
          correct_count: correctCount,
        };
        rows = [{ id: session.id }];
      }
    } else if (sql.includes("FROM app.exam_sessions")) {
      rows = session ? [session] : [];
    } else if (sql.includes("INSERT INTO app.exam_item_answers")) {
      const [, schoolId, itemId, submittedAnswer, isCorrect] = args as [
        unknown,
        string,
        string,
        string | null,
        boolean,
      ];
      answerInserts.push({
        school_id: schoolId,
        exam_item_id: itemId,
        submitted_answer: submittedAnswer,
        is_correct: isCorrect,
      });
    } else if (sql.includes("JOIN app.exam_item_answers")) {
      const items = over.items ?? [];
      const answers = over.answers ?? [];
      const byItem = new Map(answers.map((a) => [a.exam_item_id, a]));
      rows = items
        .filter((item) => byItem.has(item.id))
        .map((item) => ({
          material_id: item.material_id,
          material_title: item.material_title,
          is_correct: byItem.get(item.id)!.is_correct,
          chunk_id: item.material_chunk_id,
          page_number: item.page_number,
          section_title: item.section_title,
        }));
    } else if (sql.includes("FROM app.exam_item_options")) {
      const items = over.items ?? [];
      rows = items.flatMap((item) =>
        (item.options ?? []).map((option, index) => ({
          exam_item_id: item.id,
          option_order: index + 1,
          option_key: option.id,
          option_text: option.text,
        })),
      );
    } else if (sql.includes("FROM app.exam_items ei")) {
      rows = (over.items ?? []).map((item) => ({
        id: item.id,
        item_order: item.item_order,
        item_type: item.item_type,
        prompt: item.prompt,
        material_chunk_id: item.material_chunk_id,
        material_id: item.material_id,
        material_title: item.material_title,
        page_number: item.page_number,
        section_title: item.section_title,
      }));
    } else if (sql.includes("FROM app.exam_items")) {
      rows = (over.items ?? []).map((item) => ({
        id: item.id,
        item_order: item.item_order,
        item_type: item.item_type,
        correct_option_id: item.correct_option_id,
        correct_answer: item.correct_answer,
      }));
    }

    return Object.assign(Promise.resolve(rows), { execute: () => Promise.resolve() });
  };
  const tx = Object.assign(txFn, { json: (value: unknown) => value });

  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(tx);
    },
  });
  return { database, queries, answerInserts, getSession: () => session };
}

function quotaHandle(): AiQuotaHandle & { commits: number[] } {
  const commits: number[] = [];
  const handle: AiQuotaHandle = {
    reservationId: "res-1",
    reservedTokens: 25_000,
    settled: false,
    async commit(consumed) {
      commits.push(consumed);
      return { settled: true, remaining: 25_000 - consumed };
    },
    async release() {
      return { settled: true, remaining: 25_000 };
    },
    detach() {
      handle.settled = true;
    },
  };
  return Object.assign(handle, { commits });
}

/**
 * A `RedisClient`-shaped stub sufficient for `new Queue(name, { connection })` to construct
 * without opening a socket (BullMQ/ioredis both defer the actual connection to first use) --
 * exactly the same "constructing this object never opens a socket" property `createRedisConnection`
 * relies on elsewhere in this codebase. `.add()` itself is never exercised by these tests: like
 * `finance/reports/routes.ts` (which constructs its queue the same way and has no route-level test
 * of its own enqueue call either), the true "the job actually lands in Redis" property is an
 * integration concern outside a fake-database route test.
 */
function fakeRedis(): RedisClient {
  return {} as RedisClient;
}

function buildExamApp(
  over: {
    database?: Database;
    handle?: AiQuotaHandle;
    redis?: RedisClient | null;
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
    aiExamRoutes({
      database: over.database ?? fakeDatabase().database,
      redis: over.redis === undefined ? fakeRedis() : over.redis,
    }),
  );
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const createUrl = `/api/ai/students/${STUDENT_ID}/exams`;
const examUrl = `/api/ai/students/${STUDENT_ID}/exams/${EXAM_ID}`;
const startUrl = `${examUrl}/start`;
const submitUrl = `${examUrl}/submit`;

async function postJson(app: OpenAPIHono<AppEnv>, url: string, body: Record<string, unknown>) {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai/students/{studentId}/exams", () => {
  test("no queue configured answers 503 AI_EXAM_GENERATION_UNAVAILABLE", async () => {
    const app = buildExamApp({ redis: null });

    const res = await postJson(app, createUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_EXAM_GENERATION_UNAVAILABLE);
  });

  test("a material the school cannot see answers 404 RESOURCE_NOT_FOUND", async () => {
    const app = buildExamApp({ database: fakeDatabase({ materials: {} }).database });

    const res = await postJson(app, createUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  test("a mid-ingestion material answers 422 VALIDATION_FAILED", async () => {
    const app = buildExamApp({
      database: fakeDatabase({ materials: { [MATERIAL_ID]: { ingest_status: "processing" } } })
        .database,
    });

    const res = await postJson(app, createUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("rejects a malformed body", async () => {
    const app = buildExamApp();

    const noMaterials = await postJson(app, createUrl, { materialIds: [] });
    expect(noMaterials.status).toBe(400);

    const tooManyQuestions = await postJson(app, createUrl, {
      materialIds: [MATERIAL_ID],
      questionCount: 1000,
    });
    expect(tooManyQuestions.status).toBe(400);

    const badDuration = await postJson(app, createUrl, {
      materialIds: [MATERIAL_ID],
      durationMinutes: 0,
    });
    expect(badDuration.status).toBe(400);
  });
});

describe("GET /api/ai/students/{studentId}/exams/{examId}", () => {
  test("an unknown session answers 404 AI_EXAM_NOT_FOUND", async () => {
    const app = buildExamApp({ database: fakeDatabase({ session: null }).database });

    const res = await app.request(examUrl);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.AI_EXAM_NOT_FOUND);
  });

  test("a 'generating' session exposes no items and no report", async () => {
    const handle = quotaHandle();
    const app = buildExamApp({
      database: fakeDatabase({
        session: baseSession({ status: "generating", input_tokens: null, output_tokens: null }),
      }).database,
      handle,
    });

    const res = await app.request(examUrl);
    const body = (await res.json()) as { status: string; items: unknown; report: unknown };

    expect(res.status).toBe(200);
    expect(body.status).toBe("generating");
    expect(body.items).toBeNull();
    expect(body.report).toBeNull();
    // No LLM call on the request path; the reservation is settled at zero.
    expect(handle.commits).toEqual([0]);
  });

  test("an 'in_progress' session's items carry no answer key", async () => {
    const app = buildExamApp({
      database: fakeDatabase({
        session: baseSession({
          status: "in_progress",
          started_at: new Date("2026-01-01T00:00:00.000Z"),
          expires_at: new Date("2026-01-01T00:30:00.000Z"),
        }),
        items: gradableItems(),
      }).database,
    });

    const res = await app.request(examUrl);
    const body = (await res.json()) as { items: { id: string; options: unknown }[] };

    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(2);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("correct_option_id");
    expect(serialized).not.toContain("Cellular respiration");
    expect(body.items[0]!.options).toEqual([
      { id: "A", text: "Photosynthesis" },
      { id: "B", text: "Respiration" },
    ]);
  });

  test("a 'submitted' session exposes the per-topic report", async () => {
    const app = buildExamApp({
      database: fakeDatabase({
        session: baseSession({
          status: "submitted",
          started_at: new Date("2026-01-01T00:00:00.000Z"),
          expires_at: new Date("2026-01-01T00:30:00.000Z"),
          submitted_at: new Date("2026-01-01T00:10:00.000Z"),
          correct_count: 1,
        }),
        items: gradableItems(),
        answers: [
          { exam_item_id: ITEM_1, is_correct: true },
          { exam_item_id: ITEM_2, is_correct: false },
        ],
      }).database,
    });

    const res = await app.request(examUrl);
    const body = (await res.json()) as {
      items: unknown;
      report: {
        correct_count: number;
        total_items: number;
        percentage: number;
        topics: {
          material_id: string;
          correct: number;
          total: number;
          weak: boolean;
          study_references: { chunk_id: string }[];
        }[];
      };
    };

    expect(res.status).toBe(200);
    expect(body.items).toBeNull();
    expect(body.report.correct_count).toBe(1);
    expect(body.report.total_items).toBe(2);
    expect(body.report.percentage).toBe(50);
    expect(body.report.topics).toHaveLength(1);
    expect(body.report.topics[0]).toMatchObject({
      material_id: MATERIAL_ID,
      correct: 1,
      total: 2,
      percentage: 50,
      weak: true,
    });
    // Only the incorrect item's citation is a study reference.
    expect(body.report.topics[0]!.study_references).toEqual(
      [{ chunk_id: CHUNK_2 }].map((r) => ({
        ...r,
        page_number: 2,
        section_title: "Respiration",
      })),
    );
  });
});

describe("POST /api/ai/students/{studentId}/exams/{examId}/start", () => {
  test("an unknown session answers 404 AI_EXAM_NOT_FOUND", async () => {
    const app = buildExamApp({ database: fakeDatabase({ session: null }).database });

    const res = await app.request(startUrl, { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("starting a session not 'ready' answers 409 AI_EXAM_INVALID_STATE", async () => {
    const app = buildExamApp({
      database: fakeDatabase({ session: baseSession({ status: "generating" }) }).database,
    });

    const res = await app.request(startUrl, { method: "POST" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe(ERROR_CODES.AI_EXAM_INVALID_STATE);
  });

  test("starts a 'ready' session, stamps the timer, and reveals items with no answer key", async () => {
    const handle = quotaHandle();
    const app = buildExamApp({
      database: fakeDatabase({ session: baseSession({ status: "ready" }), items: gradableItems() })
        .database,
      handle,
    });

    const res = await app.request(startUrl, { method: "POST" });
    const body = (await res.json()) as {
      status: string;
      started_at: string | null;
      expires_at: string | null;
      items: unknown[];
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("in_progress");
    expect(body.started_at).not.toBeNull();
    expect(body.expires_at).not.toBeNull();
    expect(body.items).toHaveLength(2);
    // No LLM call; settled at zero.
    expect(handle.commits).toEqual([0]);
  });
});

describe("POST /api/ai/students/{studentId}/exams/{examId}/submit", () => {
  test("an unknown session answers 404 AI_EXAM_NOT_FOUND", async () => {
    const app = buildExamApp({ database: fakeDatabase({ session: null }).database });

    const res = await postJson(app, submitUrl, { answers: [] });
    expect(res.status).toBe(404);
  });

  test("submitting a session not 'in_progress' answers 409 AI_EXAM_INVALID_STATE", async () => {
    const app = buildExamApp({
      database: fakeDatabase({ session: baseSession({ status: "ready" }) }).database,
    });

    const res = await postJson(app, submitUrl, { answers: [] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe(ERROR_CODES.AI_EXAM_INVALID_STATE);
  });

  test("submitting after expires_at answers 409 AI_EXAM_EXPIRED", async () => {
    const app = buildExamApp({
      database: fakeDatabase({
        session: baseSession({
          status: "in_progress",
          started_at: new Date("2020-01-01T00:00:00.000Z"),
          expires_at: new Date("2020-01-01T00:30:00.000Z"),
        }),
        items: gradableItems(),
      }).database,
    });

    const res = await postJson(app, submitUrl, { answers: [] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe(ERROR_CODES.AI_EXAM_EXPIRED);
  });

  test("an answer naming an item id outside the session answers 422 VALIDATION_FAILED", async () => {
    const app = buildExamApp({
      database: fakeDatabase({
        session: baseSession({
          status: "in_progress",
          started_at: new Date(),
          expires_at: new Date(Date.now() + 30 * 60_000),
        }),
        items: gradableItems(),
      }).database,
    });

    const res = await postJson(app, submitUrl, {
      answers: [{ item_id: "40000000-0000-4000-8000-000000000000", answer: "A" }],
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("scores deterministically, persists answers, and reports a weak topic", async () => {
    const handle = quotaHandle();
    const { database, answerInserts } = fakeDatabase({
      session: baseSession({
        status: "in_progress",
        started_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 60_000),
      }),
      items: gradableItems(),
      // Once submit writes the answers, the report query needs them available too.
      answers: [
        { exam_item_id: ITEM_1, is_correct: true },
        { exam_item_id: ITEM_2, is_correct: false },
      ],
    });
    const app = buildExamApp({ database, handle });

    const res = await postJson(app, submitUrl, {
      answers: [
        { item_id: ITEM_1, answer: "A" },
        { item_id: ITEM_2, answer: "wrong answer" },
      ],
    });
    const body = (await res.json()) as {
      status: string;
      report: { correct_count: number; total_items: number; topics: { weak: boolean }[] };
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("submitted");
    expect(body.report.correct_count).toBe(1);
    expect(body.report.total_items).toBe(2);
    expect(body.report.topics[0]!.weak).toBe(true);

    // Both items were persisted, with the correct verdicts.
    expect(answerInserts).toHaveLength(2);
    expect(answerInserts.find((a) => a.exam_item_id === ITEM_1)).toMatchObject({
      submitted_answer: "A",
      is_correct: true,
    });
    expect(answerInserts.find((a) => a.exam_item_id === ITEM_2)).toMatchObject({
      submitted_answer: "wrong answer",
      is_correct: false,
    });

    // No LLM call; settled at zero.
    expect(handle.commits).toEqual([0]);
  });

  test("an unanswered item is graded wrong, not omitted", async () => {
    const { database, answerInserts } = fakeDatabase({
      session: baseSession({
        status: "in_progress",
        started_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 60_000),
      }),
      items: gradableItems(),
      answers: [
        { exam_item_id: ITEM_1, is_correct: true },
        { exam_item_id: ITEM_2, is_correct: false },
      ],
    });
    const app = buildExamApp({ database });

    const res = await postJson(app, submitUrl, { answers: [{ item_id: ITEM_1, answer: "A" }] });
    const body = (await res.json()) as { report: { correct_count: number; total_items: number } };

    expect(res.status).toBe(200);
    expect(body.report.total_items).toBe(2);
    expect(body.report.correct_count).toBe(1);
    const unanswered = answerInserts.find((a) => a.exam_item_id === ITEM_2)!;
    expect(unanswered.submitted_answer).toBeNull();
    expect(unanswered.is_correct).toBe(false);
  });
});
