import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { LlmProviderError } from "../llm/provider";
import { createDeterministicQueryEmbedder } from "../retrieval/embeddings";

import { aiAskRoutes } from "./ask-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { AiQuotaHandle } from "../gate/entitlement-gate";
import type { LlmProvider, LlmStreamEvent } from "../llm/provider";
import type { TransactionSql } from "postgres";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const CHUNK_ID = "00000000-0000-4000-8000-000000000010";
const MATERIAL_ID = "00000000-0000-4000-8000-000000000011";
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000020";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000021";
const FOREIGN_CONVERSATION_ID = "00000000-0000-4000-8000-000000000099";

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

/** A RawHit-shaped retrieval row (what runHybridQuery maps into HybridSearchHit). */
function groundedHit(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chunk_id: CHUNK_ID,
    material_id: MATERIAL_ID,
    material_title: "Biology",
    page_number: 12,
    section_title: "Photosynthesis",
    content:
      "Photosynthesis is the process by which plants convert light energy into chemical energy.",
    rrf_score: 0.0333,
    semantic_rank: 1,
    keyword_rank: 1,
    ...over,
  };
}

/**
 * Fake postgres.js Sql that answers by what the query asks for, so withTenantTx's setup, the
 * hybrid-search legs, the conversation resolve, and the persistence writes all resolve without a
 * database. Every query recorded so tests can assert what was (not) written.
 */
function fakeDatabase(
  opts: { hits?: Record<string, unknown>[]; conversationExists?: boolean } = {},
) {
  const queries: string[] = [];
  const hitRows = opts.hits ?? [groundedHit()];
  const rows = (list: unknown[]) => {
    const result = Promise.resolve(list);
    return Object.assign(result, { execute: () => Promise.resolve() });
  };
  const tx = ((strings: TemplateStringsArray) => {
    const sql = strings.join("\u0000");
    queries.push(sql);
    if (sql.includes("FROM fused")) return rows(hitRows);
    if (sql.includes("ORDER BY embedding"))
      return rows(Array.from({ length: 50 }, (_, i) => ({ id: `c-${i}` })));
    if (sql.includes("FROM app.ai_conversations")) {
      return rows(opts.conversationExists ? [{ id: CONVERSATION_ID }] : []);
    }
    if (sql.includes("INSERT INTO app.ai_conversations")) return rows([{ id: CONVERSATION_ID }]);
    if (sql.includes("FROM app.ai_subscriptions")) return rows([{ id: "sub-1" }]);
    if (sql.includes("upsert_ai_usage_tokens")) return rows([]);
    if (sql.includes("INSERT INTO app.ai_messages")) return rows([{ id: MESSAGE_ID }]);
    if (sql.includes("INSERT INTO app.ai_message_citations")) return rows([]);
    return rows([]);
  }) as unknown as TransactionSql;
  (tx as unknown as { unsafe: unknown }).unsafe = async () => undefined;
  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(tx);
    },
  });
  return { database, queries };
}

function quotaHandle() {
  const commits: number[] = [];
  const releases: number[] = [];
  let detached = false;
  const handle: AiQuotaHandle = {
    reservationId: "res-1",
    reservedTokens: 1000,
    settled: false,
    async commit(consumed) {
      commits.push(consumed);
      return { settled: true, remaining: 1000 - consumed };
    },
    async release() {
      releases.push(1);
      return { settled: true, remaining: 1000 };
    },
    detach() {
      detached = true;
    },
  };
  return Object.assign(handle, {
    commits,
    releases,
    wasDetached: () => detached,
  });
}

function fakeProvider(events: AsyncGenerator<LlmStreamEvent, void, unknown>): LlmProvider {
  return {
    generate: async () => {
      throw new Error("generate should not be called by the ask route");
    },
    stream: () => events,
  };
}

function answeredStream(
  text = "Photosynthesis converts light [1] energy.",
): AsyncGenerator<LlmStreamEvent, void, unknown> {
  return (async function* () {
    let acc = "";
    const chunks = text.match(/[\s\S]{1,4}/g) ?? [text];
    for (const chunk of chunks) {
      acc += chunk;
      yield { type: "delta", delta: chunk, text: acc };
    }
    yield {
      type: "done",
      text: acc,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      stopReason: "end_turn",
      model: "test-model",
    };
  })();
}

function failingStream(error: unknown): AsyncGenerator<LlmStreamEvent, void, unknown> {
  return (async function* () {
    let acc = "";
    const chunks = ["partial", " answer", " then "];
    for (const chunk of chunks) {
      acc += chunk;
      yield { type: "delta", delta: chunk, text: acc };
    }
    throw error;
  })();
}

function buildAskApp(
  provider: LlmProvider | null,
  opts: {
    database?: ReturnType<typeof fakeDatabase>;
    handle?: ReturnType<typeof quotaHandle>;
    modelOverrides?: Record<string, string>;
  } = {},
): {
  app: OpenAPIHono<AppEnv>;
  db: ReturnType<typeof fakeDatabase>;
  quota: ReturnType<typeof quotaHandle>;
} {
  const db = opts.database ?? fakeDatabase();
  const quota = opts.handle ?? quotaHandle();
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    c.set("aiQuota", quota);
    await next();
  });
  app.route(
    "/",
    aiAskRoutes({
      database: db.database,
      provider,
      embedder: createDeterministicQueryEmbedder(),
      modelOverrides: opts.modelOverrides,
    }),
  );
  app.onError(errorHandlerMiddleware(silentLogger));
  return { app, db, quota };
}

const askUrl = `/api/ai/students/${STUDENT_ID}/ask`;

async function postAsk(app: OpenAPIHono<AppEnv>, body: Record<string, unknown>): Promise<Response> {
  return app.request(askUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseSse(text: string): { event: string; data: Record<string, unknown> }[] {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  for (const block of text.split("\n\n")) {
    const eventLine = block.split("\n").find((line) => line.startsWith("event:"));
    const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
    if (!eventLine || !dataLine) continue;
    events.push({
      event: eventLine.slice("event:".length).trim(),
      data: JSON.parse(dataLine.slice("data:".length).trim()) as Record<string, unknown>,
    });
  }
  return events;
}

describe("POST /api/ai/students/{studentId}/ask", () => {
  test("a null provider answers 503 AI_LLM_DISABLED before any stream", async () => {
    const { app } = buildAskApp(null);

    const res = await postAsk(app, { question: "How does photosynthesis work?" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_DISABLED);
  });

  test("an empty question is rejected with 400 at the OpenAPI boundary", async () => {
    const { app } = buildAskApp(fakeProvider(answeredStream()));

    const res = await postAsk(app, { question: "   " });

    expect(res.status).toBe(400);
  });

  test("a grounded question streams sources, deltas, and done, then commits the actual tokens", async () => {
    const db = fakeDatabase();
    const { app, quota } = buildAskApp(fakeProvider(answeredStream()), { database: db });

    const res = await postAsk(app, { question: "How does photosynthesis work?" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await res.text());

    const sources = events[0];
    expect(sources.event).toBe("sources");
    expect(sources.data.conversation_id).toBe(CONVERSATION_ID);
    expect(sources.data.model).toBe("claude-sonnet-4-20250514");
    expect(sources.data.tier).toBe("large");
    const sourceAnchors = sources.data.sources as Record<string, unknown>[];
    expect(sourceAnchors).toHaveLength(1);
    expect(sourceAnchors[0]).toMatchObject({
      order: 1,
      chunk_id: CHUNK_ID,
      material_id: MATERIAL_ID,
      material_title: "Biology",
      page_number: 12,
      section_title: "Photosynthesis",
    });

    const deltas = events.filter((event) => event.event === "delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect((deltas[0].data.delta as string).length).toBeGreaterThan(0);

    const done = events[events.length - 1];
    expect(done.event).toBe("done");
    expect(done.data.message_id).toBe(MESSAGE_ID);
    expect(done.data.conversation_id).toBe(CONVERSATION_ID);
    expect(done.data.text).toBe("Photosynthesis converts light [1] energy.");
    expect(done.data.stop_reason).toBe("end_turn");
    expect(done.data.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
    const citations = done.data.citations as Record<string, unknown>[];
    expect(citations).toHaveLength(1);
    expect(citations[0].chunk_id).toBe(CHUNK_ID);
    expect(citations[0].order).toBe(1);

    // The conversation, message, and durable usage were written; the turn committed 30 tokens.
    expect(db.queries.some((q) => q.includes("INSERT INTO app.ai_conversations"))).toBe(true);
    expect(db.queries.some((q) => q.includes("INSERT INTO app.ai_messages"))).toBe(true);
    expect(db.queries.some((q) => q.includes("INSERT INTO app.ai_message_citations"))).toBe(true);
    expect(quota.commits).toEqual([30]);
    expect(quota.releases).toEqual([]);
  });

  test("model overrides flow through the routing table into the wire events", async () => {
    const { app } = buildAskApp(fakeProvider(answeredStream()), {
      modelOverrides: { large: "custom-sonnet" },
    });

    const res = await postAsk(app, { question: "How does photosynthesis work?" });
    const events = parseSse(await res.text());

    expect(events[0].data.model).toBe("custom-sonnet");
    expect(events[events.length - 1].data.model).toBe("custom-sonnet");
  });

  test("an ungrounded question streams a single refusal event with nearest topics", async () => {
    const db = fakeDatabase({
      // Semantic-only hit: a high RRF score from the deterministic mock embedder still does not
      // clear the keyword-leg AND arm of assessGrounding, so the answer is refused.
      hits: [groundedHit({ keyword_rank: null, rrf_score: 0.05 })],
    });
    const { app, quota } = buildAskApp(fakeProvider(answeredStream()), { database: db });

    const res = await postAsk(app, { question: "Something the corpus does not mention at all" });

    expect(res.status).toBe(200);
    const events = parseSse(await res.text());

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("refusal");
    expect(events[0].data.code).toBe(ERROR_CODES.AI_ASK_INSUFFICIENT_GROUNDING);
    const topics = events[0].data.topics as Record<string, unknown>[];
    expect(topics[0].chunk_id).toBe(CHUNK_ID);
    expect(topics[0].material_title).toBe("Biology");

    // No provider answer was produced, so nothing was persisted or committed; the hold was released.
    expect(db.queries.some((q) => q.includes("INSERT INTO app.ai_messages"))).toBe(false);
    expect(quota.commits).toEqual([]);
    expect(quota.releases).toEqual([1]);
  });

  test("a below-threshold best hit is refused too", async () => {
    const db = fakeDatabase({ hits: [groundedHit({ rrf_score: 0.01, keyword_rank: 3 })] });
    const { app } = buildAskApp(fakeProvider(answeredStream()), { database: db });

    const res = await postAsk(app, { question: "Something distant" });
    const events = parseSse(await res.text());

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("refusal");
  });

  test("a foreign conversation_id answers 404 AI_CONVERSATION_NOT_FOUND", async () => {
    const db = fakeDatabase({ conversationExists: false });
    const { app } = buildAskApp(fakeProvider(answeredStream()), { database: db });

    const res = await postAsk(app, {
      question: "How does photosynthesis work?",
      conversation_id: FOREIGN_CONVERSATION_ID,
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.AI_CONVERSATION_NOT_FOUND);
  });

  test("a mid-stream provider failure streams an error event and releases the hold", async () => {
    const db = fakeDatabase();
    const { app, quota } = buildAskApp(
      fakeProvider(failingStream(new LlmProviderError("connection lost", 503, "network"))),
      { database: db },
    );

    const res = await postAsk(app, { question: "How does photosynthesis work?" });
    const events = parseSse(await res.text());

    expect(events[0].event).toBe("sources");
    const error = events[events.length - 1];
    expect(error.event).toBe("error");
    expect(error.data.code).toBe(ERROR_CODES.AI_LLM_UNAVAILABLE);

    // A turn that never completed is not persisted and its reservation is released, not committed.
    expect(db.queries.some((q) => q.includes("INSERT INTO app.ai_messages"))).toBe(false);
    expect(quota.commits).toEqual([]);
    expect(quota.releases).toEqual([1]);
  });

  test("a non-transient 4xx verdict streams AI_LLM_REQUEST_REJECTED", async () => {
    const { app } = buildAskApp(
      fakeProvider(failingStream(new LlmProviderError("bad request", 400, "http"))),
    );

    const res = await postAsk(app, { question: "How does photosynthesis work?" });
    const events = parseSse(await res.text());

    expect(events[events.length - 1].event).toBe("error");
    expect(events[events.length - 1].data.code).toBe(ERROR_CODES.AI_LLM_REQUEST_REJECTED);
  });
});
