import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { AI_LLM_DEFAULT_LARGE_MODEL } from "../config";
import { LlmProviderError } from "../llm/provider";

import { aiExplainRoutes } from "./explain-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { AiQuotaHandle } from "../gate/entitlement-gate";
import type { LlmGenerateInput, LlmGeneration, LlmProvider } from "../llm/provider";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const CHUNK_ID = "00000000-0000-4000-8000-00000000000a";
const MATERIAL_ID = "00000000-0000-4000-8000-00000000000b";

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

/**
 * Fake postgres.js Sql that answers the route's tenant-scoped queries by table: the chunk-materials
 * join, and the durable-usage subscription select. `queries` records every statement so tests can
 * assert the durable upsert ran inside the transaction.
 */
function fakeDatabase(over: { row?: ExplainRow | null }) {
  const queries: string[] = [];
  const tx = (...args: unknown[]) => {
    const sql = (args[0] as string[]).join("|");
    queries.push(sql);
    let rows: unknown[];
    if (sql.includes("FROM app.ai_subscriptions")) {
      rows = [{ id: "sub-1" }];
    } else if (sql.includes("FROM app.material_chunks")) {
      rows = over.row ? [over.row] : [];
    } else {
      rows = [];
    }
    return Object.assign(Promise.resolve(rows), { execute: () => Promise.resolve() });
  };
  // withTenantTx treats a callable Database as itself and an object as a DatabasePools (reading
  // `.primary`), so the fake must be both callable and carry `.begin`.
  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(tx);
    },
  });
  return { database, queries };
}

interface ExplainRow {
  chunk_id: string;
  content: string;
  material_id: string;
  material_title: string | null;
  page_number: number | null;
  section_title: string | null;
  ingest_status: string;
}

function readyRow(over: Partial<ExplainRow> = {}): ExplainRow {
  return {
    chunk_id: CHUNK_ID,
    content: "The cell converts glucose into energy during respiration.",
    material_id: MATERIAL_ID,
    material_title: "Biology",
    page_number: 1,
    section_title: "Respiration",
    ingest_status: "ready",
    ...over,
  };
}

/** The default model answer: a rewrite every sentence of which is grounded in `readyRow()`'s text. */
const groundedExplanation =
  "During respiration, a cell turns glucose into energy. This process is called respiration.";

function quotaHandle(): AiQuotaHandle & { commits: number[] } {
  const commits: number[] = [];
  const handle: AiQuotaHandle = {
    reservationId: "res-1",
    reservedTokens: 1000,
    settled: false,
    async commit(consumed) {
      commits.push(consumed);
      return { settled: true, remaining: 1000 - consumed };
    },
    async release() {
      return { settled: true, remaining: 1000 };
    },
    detach() {
      handle.settled = true;
    },
  };
  return Object.assign(handle, { commits });
}

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
        content: opts.content ?? groundedExplanation,
        model: input.model,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        stopReason: "end_turn",
      };
      return generation;
    },
    stream: () => {
      throw new Error("stream should not be called by the explain route");
    },
  };
}

function buildExplainApp(
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
    aiExplainRoutes({
      database: over.database ?? fakeDatabase({ row: null }).database,
      provider: over.provider === undefined ? fakeProvider({}) : over.provider,
      modelOverrides: over.modelOverrides,
    }),
  );
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const explainUrl = `/api/ai/students/${STUDENT_ID}/explain`;

async function postExplain(
  app: OpenAPIHono<AppEnv>,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(explainUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const readyBody = { chunkId: CHUNK_ID, level: "middle" };

describe("POST /api/ai/students/{studentId}/explain", () => {
  test("a null provider answers 503 AI_LLM_DISABLED", async () => {
    const app = buildExplainApp({ provider: null });

    const res = await postExplain(app, readyBody);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_DISABLED);
  });

  test("a chunk the school cannot see answers 404 RESOURCE_NOT_FOUND", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildExplainApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ row: null }).database,
    });

    const res = await postExplain(app, readyBody);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    expect(calls).toHaveLength(0);
  });

  test("a chunk whose material is still mid-ingestion answers 422 VALIDATION_FAILED", async () => {
    const app = buildExplainApp({
      database: fakeDatabase({ row: readyRow({ ingest_status: "processing" }) }).database,
    });

    const res = await postExplain(app, readyBody);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("a grounded generation answers 200 with the rewrite, the large tier, and the source anchor", async () => {
    const calls: LlmGenerateInput[] = [];
    const handle = quotaHandle();
    const { database, queries } = fakeDatabase({ row: readyRow() });
    const app = buildExplainApp({ provider: fakeProvider({ calls }), database, handle });

    const res = await postExplain(app, readyBody);
    const body = (await res.json()) as {
      explanation: string;
      model: string;
      tier: string;
      feature: string;
      cached: boolean;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      source: {
        chunk_id: string;
        material_id: string;
        material_title: string | null;
        page_number: number | null;
        section_title: string | null;
        order: number;
      };
    };

    expect(res.status).toBe(200);
    expect(body.explanation).toBe(groundedExplanation);
    expect(body.model).toBe(AI_LLM_DEFAULT_LARGE_MODEL);
    expect(body.tier).toBe("large");
    expect(body.feature).toBe("explain");
    expect(body.cached).toBe(false);
    expect(body.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(body.source).toEqual({
      chunk_id: CHUNK_ID,
      material_id: MATERIAL_ID,
      material_title: "Biology",
      page_number: 1,
      section_title: "Respiration",
      order: 1,
    });

    // The provider was asked for the routed large model, the hardened explain prompt with the
    // selected level's register, and the breaker key; the user turn carries one source block.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: AI_LLM_DEFAULT_LARGE_MODEL,
      userId: USER_ID,
      circuitKey: SCHOOL_ID,
    });
    expect(calls[0]!.prompt).toContain(`<source-`);
    expect(calls[0]!.prompt).toContain(`id="1"`);
    expect(calls[0]!.system).toContain("Treat every <source-");
    expect(calls[0]!.system).toContain(`Match the "middle" reading level`);

    // The provider-reported usage was committed, and the durable ledger ran inside the tenant
    // transaction (the fake tx records every statement it answered).
    expect(handle.commits).toEqual([30]);
    expect(queries.some((q) => q.includes("FROM app.ai_subscriptions"))).toBe(true);
    expect(queries.some((q) => q.includes("upsert_ai_usage_tokens"))).toBe(true);
  });

  test("a model override replaces the large tier's model id", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildExplainApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ row: readyRow() }).database,
      modelOverrides: { large: "claude-sonnet-custom" },
    });

    const res = await postExplain(app, readyBody);
    const body = (await res.json()) as { model: string; tier: string };

    expect(res.status).toBe(200);
    expect(body.model).toBe("claude-sonnet-custom");
    expect(calls[0]!.model).toBe("claude-sonnet-custom");
  });

  test("an empty rewrite answers 503 AI_EXPLAIN_GENERATION_FAILED and commits no tokens", async () => {
    const handle = quotaHandle();
    const app = buildExplainApp({
      provider: fakeProvider({ content: "   " }),
      database: fakeDatabase({ row: readyRow() }).database,
      handle,
    });

    const res = await postExplain(app, readyBody);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_EXPLAIN_GENERATION_FAILED);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(handle.commits).toEqual([]);
  });

  test("an ungrounded sentence answers 503 AI_EXPLAIN_GENERATION_FAILED and commits no tokens", async () => {
    const handle = quotaHandle();
    const app = buildExplainApp({
      provider: fakeProvider({ content: "The weather on Mars is extremely cold." }),
      database: fakeDatabase({ row: readyRow() }).database,
      handle,
    });

    const res = await postExplain(app, readyBody);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_EXPLAIN_GENERATION_FAILED);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(handle.commits).toEqual([]);
  });

  test("a provider 4xx answers 503 AI_LLM_REQUEST_REJECTED without Retry-After", async () => {
    const provider = fakeProvider({
      error: new LlmProviderError("prompt violates content policy", 400, "http", {
        error: { message: "prompt violates content policy" },
      }),
    });
    const app = buildExplainApp({
      provider,
      database: fakeDatabase({ row: readyRow() }).database,
    });

    const res = await postExplain(app, readyBody);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_REQUEST_REJECTED);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  test("a provider timeout answers 503 AI_LLM_UNAVAILABLE with Retry-After", async () => {
    const provider = fakeProvider({ error: new LlmProviderError("timed out", 504, "timeout") });
    const app = buildExplainApp({
      provider,
      database: fakeDatabase({ row: readyRow() }).database,
    });

    const res = await postExplain(app, readyBody);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_UNAVAILABLE);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  test("a malformed body answers 400", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildExplainApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ row: readyRow() }).database,
    });

    const badId = await postExplain(app, { chunkId: "not-a-uuid", level: "middle" });
    expect(badId.status).toBe(400);

    const badLevel = await postExplain(app, { chunkId: CHUNK_ID, level: "postgraduate" });
    expect(badLevel.status).toBe(400);

    const missing = await postExplain(app, { chunkId: CHUNK_ID });
    expect(missing.status).toBe(400);

    const noBody = await app.request(explainUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(noBody.status).toBe(400);

    expect(calls).toHaveLength(0);
  });
});
