import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { aiSubscriberFeatureService } from "../../features/__tests__/fakes";
import { restoreCitationOrders } from "../ask/history";

import { aiAskHistoryRoutes } from "./ask-history-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { TransactionSql } from "postgres";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000020";
const OTHER_CONVERSATION_ID = "00000000-0000-4000-8000-000000000021";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000030";
const CHUNK_A = "00000000-0000-4000-8000-000000000040";
const CHUNK_B = "00000000-0000-4000-8000-000000000041";
const MATERIAL_ID = "00000000-0000-4000-8000-000000000050";

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

interface FakeData {
  summaries?: Record<string, unknown>[];
  conversationExists?: boolean;
  messages?: Record<string, unknown>[];
  citations?: Record<string, unknown>[];
}

/** Fake postgres.js Sql answering by query shape; records each query's text and parameters. */
function fakeDatabase(data: FakeData = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const rows = (list: unknown[]) =>
    Object.assign(Promise.resolve(list), { execute: () => Promise.resolve() });
  const tx = ((strings: TemplateStringsArray, ...params: unknown[]) => {
    const sql = strings.join("\u0000");
    queries.push({ sql, params });
    if (sql.includes("JOIN LATERAL")) return rows(data.summaries ?? []);
    if (sql.includes("FROM app.ai_conversations")) {
      return rows(
        data.conversationExists
          ? [{ id: CONVERSATION_ID, created_at: new Date("2026-10-01T09:00:00Z") }]
          : [],
      );
    }
    if (sql.includes("FROM app.ai_message_citations")) return rows(data.citations ?? []);
    if (sql.includes("FROM app.ai_messages")) return rows(data.messages ?? []);
    return rows([]);
  }) as unknown as TransactionSql;
  (tx as unknown as { unsafe: unknown }).unsafe = async () => undefined;
  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  });
  return { database, queries };
}

function buildApp(db: ReturnType<typeof fakeDatabase>) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    c.set("features", aiSubscriberFeatureService());
    await next();
  });
  app.route("/", aiAskHistoryRoutes({ database: db.database }));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

function summary(id: string, lastMessageAt: string) {
  return {
    id,
    title: "How does photosynthesis work?",
    message_count: 3,
    created_at: new Date("2026-10-01T09:00:00Z"),
    last_message_at: new Date(lastMessageAt),
  };
}

describe("GET /api/ai/students/{studentId}/conversations", () => {
  test("lists conversations and returns no cursor on the last page", async () => {
    const db = fakeDatabase({ summaries: [summary(CONVERSATION_ID, "2026-10-02T10:00:00Z")] });
    const res = await buildApp(db).request(`/api/ai/students/${STUDENT_ID}/conversations`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      conversations: [
        {
          id: CONVERSATION_ID,
          title: "How does photosynthesis work?",
          message_count: 3,
          created_at: "2026-10-01T09:00:00.000Z",
          last_message_at: "2026-10-02T10:00:00.000Z",
        },
      ],
      next_before: null,
    });
    const listQuery = db.queries.find((q) => q.sql.includes("JOIN LATERAL"))!;
    expect(listQuery.params).toContain(STUDENT_ID);
  });

  test("returns the last row's activity time as the next cursor when more exist", async () => {
    const db = fakeDatabase({
      summaries: [
        summary(CONVERSATION_ID, "2026-10-02T10:00:00Z"),
        summary(OTHER_CONVERSATION_ID, "2026-10-01T10:00:00Z"),
      ],
    });
    const res = await buildApp(db).request(
      `/api/ai/students/${STUDENT_ID}/conversations?limit=1&before=2026-10-05T00:00:00.000Z`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[]; next_before: string | null };
    expect(body.conversations).toHaveLength(1);
    expect(body.next_before).toBe("2026-10-02T10:00:00.000Z");
    const listQuery = db.queries.find((q) => q.sql.includes("JOIN LATERAL"))!;
    // limit + 1 is fetched to detect a further page.
    expect(listQuery.params).toContain(2);
  });

  test("rejects an out-of-range limit", async () => {
    const res = await buildApp(fakeDatabase()).request(
      `/api/ai/students/${STUDENT_ID}/conversations?limit=500`,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/ai/students/{studentId}/conversations/{conversationId}", () => {
  test("returns the turns with citations numbered as the answer cites them", async () => {
    const db = fakeDatabase({
      conversationExists: true,
      messages: [
        {
          id: MESSAGE_ID,
          question: "What is photosynthesis?",
          answer: "Plants use light [3] to make sugar [1].",
          created_at: new Date("2026-10-01T09:01:00Z"),
        },
      ],
      citations: [
        {
          ai_message_id: MESSAGE_ID,
          chunk_id: CHUNK_A,
          material_id: MATERIAL_ID,
          material_title: "Biology",
          page_number: 4,
          section_title: "Light",
        },
        {
          ai_message_id: MESSAGE_ID,
          chunk_id: CHUNK_B,
          material_id: MATERIAL_ID,
          material_title: "Biology",
          page_number: null,
          section_title: null,
        },
      ],
    });
    const res = await buildApp(db).request(
      `/api/ai/students/${STUDENT_ID}/conversations/${CONVERSATION_ID}`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: { question: string; citations: { order: number; chunk_id: string }[] }[];
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.question).toBe("What is photosynthesis?");
    expect(body.messages[0]!.citations.map((c) => [c.order, c.chunk_id])).toEqual([
      [3, CHUNK_A],
      [1, CHUNK_B],
    ]);
  });

  test("answers 404 for a conversation that is not this student's", async () => {
    const res = await buildApp(fakeDatabase({ conversationExists: false })).request(
      `/api/ai/students/${STUDENT_ID}/conversations/${CONVERSATION_ID}`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe(ERROR_CODES.AI_CONVERSATION_NOT_FOUND);
  });
});

describe("restoreCitationOrders", () => {
  test("drops the out-of-range ids the resolver discarded", () => {
    expect(restoreCitationOrders("a [9] b [2] c [1] d [2]", 2)).toEqual([2, 1]);
  });

  test("falls back to positional orders when text and rows disagree", () => {
    expect(restoreCitationOrders("no markers left", 2)).toEqual([1, 2]);
  });
});
