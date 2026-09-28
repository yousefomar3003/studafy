import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { summaryCacheKey, summaryFingerprint, type SummaryCache } from "../summary/cache";

import { aiReportRoutes } from "./report-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { TransactionSql } from "postgres";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_STUDENT_ID = "00000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000021";
const QUIZ_ID = "00000000-0000-4000-8000-000000000022";
const DECK_ID = "00000000-0000-4000-8000-000000000023";
const MATERIAL_ID = "00000000-0000-4000-8000-000000000024";
const CHUNK_ID = "00000000-0000-4000-8000-000000000025";
const REPORT_ID = "00000000-0000-4000-8000-000000000031";

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
  userId: STUDENT_ID,
  schoolId: SCHOOL_ID,
  roles: [ROLES.STUDENT],
  channel: AUTH_CHANNELS.API,
  jti: "jti-1",
  entitlementsVer: 1,
  subscriptionStatus: "active",
};

interface Insert {
  sql: string;
  values: unknown[];
}

function fakeDatabase(opts: { contentExists?: boolean; duplicateReport?: boolean } = {}) {
  const contentExists = opts.contentExists ?? true;
  const inserts: Insert[] = [];

  const result = (rows: unknown[]) =>
    Object.assign(Promise.resolve(rows), { execute: () => Promise.resolve() });

  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("INSERT INTO app.ai_content_reports")) {
      inserts.push({ sql, values });
      if (opts.duplicateReport) {
        const err = Object.assign(new Error("duplicate key"), { code: "23505" });
        return Object.assign(Promise.reject(err), { execute: () => Promise.resolve() });
      }
      return result([{ id: REPORT_ID }]);
    }
    if (!contentExists) return result([]);
    if (sql.includes("FROM app.ai_messages")) {
      return result([{ question: "What is osmosis?", answer: "Osmosis is diffusion of water." }]);
    }
    if (sql.includes("FROM app.quizzes")) {
      return result([
        {
          question_order: 1,
          prompt: "Which gas do plants absorb?",
          correct_answer: null,
          correct_option_id: "b",
          option_key: "a",
          option_text: "Oxygen",
        },
        {
          question_order: 1,
          prompt: "Which gas do plants absorb?",
          correct_answer: null,
          correct_option_id: "b",
          option_key: "b",
          option_text: "Carbon dioxide",
        },
      ]);
    }
    if (sql.includes("FROM app.flashcard_decks")) {
      return result([{ card_order: 1, front: "Mitosis", back: "Cell division" }]);
    }
    if (sql.includes("FROM app.materials")) {
      return result([{ id: MATERIAL_ID, title: "Cells", ingest_status: "ready" }]);
    }
    if (sql.includes("FROM app.material_chunks")) {
      return result([
        { id: CHUNK_ID, chunk_index: 0, page_number: 1, section_title: null, content: "Cells." },
      ]);
    }
    return result([]);
  }) as unknown as TransactionSql;

  (tx as unknown as { unsafe: unknown }).unsafe = async () => undefined;

  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(tx);
    },
  });

  return { database, inserts };
}

function fakeSummaryCache(summary: string | null): SummaryCache {
  const fingerprint = summaryFingerprint(MATERIAL_ID, [
    { id: CHUNK_ID, chunkIndex: 0, pageNumber: 1, sectionTitle: null, content: "Cells." },
  ] as never);
  const key = summaryCacheKey(STUDENT_ID, MATERIAL_ID, "standard", fingerprint);
  return {
    get: async (requested) =>
      summary !== null && requested === key
        ? { summary, model: "m", tier: "small", length: "standard", sources: [] }
        : null,
    set: async () => undefined,
  };
}

function buildApp(database: Database, summaryCache = fakeSummaryCache(null)) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    await next();
  });
  app.route("/", aiReportRoutes({ database, summaryCache }));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

function post(app: OpenAPIHono<AppEnv>, url: string, body: Record<string, unknown>) {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const reportsUrl = `/api/ai/students/${STUDENT_ID}/reports`;

/** The snapshot and priority an insert carried, read off its bound values by column position. */
function insertedValues(insert: Insert) {
  const [, , contentType, contentId, snapshot, , reasonCategory, reason, priority] = insert.values;
  return { contentType, contentId, snapshot, reasonCategory, reason, priority };
}

describe("POST /api/ai/students/{studentId}/reports", () => {
  test("files a quiz report with a server-read snapshot, marking the correct option", async () => {
    const { database, inserts } = fakeDatabase();
    const res = await post(buildApp(database), reportsUrl, {
      content_type: "quiz",
      content_id: QUIZ_ID,
      reason_category: "inaccurate",
    });
    const body = (await res.json()) as { report_id: string; priority: string; respond_by: string };

    expect(res.status).toBe(201);
    expect(body.report_id).toBe(REPORT_ID);
    expect(body.priority).toBe("normal");
    expect(new Date(body.respond_by).getTime()).toBeGreaterThan(Date.now());
    const values = insertedValues(inserts[0]!);
    expect(values.contentType).toBe("quiz");
    expect(values.snapshot).toContain("Q1. Which gas do plants absorb?");
    expect(values.snapshot).toContain("b) Carbon dioxide (correct)");
  });

  test("files a flashcard deck report", async () => {
    const { database, inserts } = fakeDatabase();
    const res = await post(buildApp(database), reportsUrl, {
      content_type: "flashcard_deck",
      content_id: DECK_ID,
      reason_category: "inappropriate",
      reason: "Card 1 is rude",
    });

    expect(res.status).toBe(201);
    const values = insertedValues(inserts[0]!);
    expect(values.snapshot).toContain("Front: Mitosis");
    expect(values.reason).toBe("Card 1 is rude");
    expect(values.priority).toBe("high");
  });

  test("a child-safety report is urgent", async () => {
    const { database } = fakeDatabase();
    const res = await post(buildApp(database), reportsUrl, {
      content_type: "ask_answer",
      content_id: MESSAGE_ID,
      reason_category: "child_safety",
    });
    const body = (await res.json()) as { priority: string };

    expect(res.status).toBe(201);
    expect(body.priority).toBe("urgent");
  });

  test("files a summary report from the cached summary the student was served", async () => {
    const { database, inserts } = fakeDatabase();
    const res = await post(buildApp(database, fakeSummaryCache("Cells are small.")), reportsUrl, {
      content_type: "summary",
      content_id: MATERIAL_ID,
      summary_length: "standard",
      reason_category: "other",
    });

    expect(res.status).toBe(201);
    expect(insertedValues(inserts[0]!).snapshot).toBe("Cells are small.");
  });

  test("404 when the summary is no longer cached -- client text is never trusted", async () => {
    const { database, inserts } = fakeDatabase();
    const res = await post(buildApp(database), reportsUrl, {
      content_type: "summary",
      content_id: MATERIAL_ID,
      summary_length: "standard",
      reason_category: "other",
    });

    expect(res.status).toBe(404);
    expect(inserts).toHaveLength(0);
  });

  test("400 when a summary report omits its length preset", async () => {
    const { database } = fakeDatabase();
    const res = await post(buildApp(database), reportsUrl, {
      content_type: "summary",
      content_id: MATERIAL_ID,
      reason_category: "other",
    });

    expect(res.status).toBe(400);
  });

  test("404 when the item does not exist for this student", async () => {
    const { database } = fakeDatabase({ contentExists: false });
    const res = await post(buildApp(database), reportsUrl, {
      content_type: "quiz",
      content_id: QUIZ_ID,
      reason_category: "other",
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  test("409 when this student already reported the item", async () => {
    const { database } = fakeDatabase({ duplicateReport: true });
    const res = await post(buildApp(database), reportsUrl, {
      content_type: "quiz",
      content_id: QUIZ_ID,
      reason_category: "other",
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe(ERROR_CODES.AI_ANSWER_REPORTED);
  });

  test("403 when reporting on behalf of another student", async () => {
    const { database, inserts } = fakeDatabase();
    const res = await post(buildApp(database), `/api/ai/students/${OTHER_STUDENT_ID}/reports`, {
      content_type: "quiz",
      content_id: QUIZ_ID,
      reason_category: "other",
    });

    expect(res.status).toBe(403);
    expect(inserts).toHaveLength(0);
  });

  test("400 on a content type students cannot report", async () => {
    const { database } = fakeDatabase();
    const res = await post(buildApp(database), reportsUrl, {
      content_type: "ask_question",
      content_id: MESSAGE_ID,
      reason_category: "other",
    });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/ai/students/{studentId}/messages/{messageId}/report (legacy)", () => {
  const legacyUrl = `/api/ai/students/${STUDENT_ID}/messages/${MESSAGE_ID}/report`;

  test("files an ask_answer report with reason category other", async () => {
    const { database, inserts } = fakeDatabase();
    const res = await post(buildApp(database), legacyUrl, { reason: "This answer is incorrect" });
    const body = (await res.json()) as { report_id: string; message: string };

    expect(res.status).toBe(201);
    expect(body.report_id).toBe(REPORT_ID);
    expect(body.message).toContain("reported");
    const values = insertedValues(inserts[0]!);
    expect(values.contentType).toBe("ask_answer");
    expect(values.contentId).toBe(MESSAGE_ID);
    expect(values.reasonCategory).toBe("other");
    expect(values.snapshot).toContain("Answer: Osmosis is diffusion of water.");
  });

  test("404 when the message does not exist", async () => {
    const { database } = fakeDatabase({ contentExists: false });
    const res = await post(buildApp(database), legacyUrl, { reason: "Bad answer" });

    expect(res.status).toBe(404);
  });

  test("409 on duplicate report", async () => {
    const { database } = fakeDatabase({ duplicateReport: true });
    const res = await post(buildApp(database), legacyUrl, { reason: "Already reported this" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe(ERROR_CODES.AI_ANSWER_REPORTED);
  });

  test("400 on empty reason", async () => {
    const { database } = fakeDatabase();
    const res = await post(buildApp(database), legacyUrl, { reason: "   " });

    expect(res.status).toBe(400);
  });
});
