import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { AI_LLM_DEFAULT_SMALL_MODEL } from "../config";
import { LlmProviderError } from "../llm/provider";

import { aiSummaryRoutes } from "./summary-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { AiQuotaHandle } from "../gate/entitlement-gate";
import type { LlmGenerateInput, LlmGeneration, LlmProvider } from "../llm/provider";
import type { SummaryCache, SummaryCacheEntry, SummaryCacheSource } from "../summary/cache";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const MATERIAL_ID = "00000000-0000-4000-8000-00000000000a";

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
      content: "Photosynthesis converts light energy.",
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

/**
 * Fake postgres.js Sql that answers the route's tenant-scoped queries by table: the material
 * select, the chunk select, and the durable-usage subscription select. `queries` records every
 * statement so tests can assert the durable upsert ran inside the transaction.
 */
function fakeDatabase(over: {
  material?: { id: string; title: string | null; ingest_status: string } | null;
  chunks?: ChunkRow[];
}) {
  const queries: string[] = [];
  const tx = (...args: unknown[]) => {
    const sql = (args[0] as string[]).join("|");
    queries.push(sql);
    let rows: unknown[];
    if (sql.includes("FROM app.ai_subscriptions")) {
      rows = [{ id: "sub-1" }];
    } else if (sql.includes("FROM app.material_chunks")) {
      rows = over.chunks ?? [];
    } else if (sql.includes("FROM app.materials")) {
      rows = over.material ? [over.material] : [];
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

function fakeProvider(opts: { error?: unknown; calls?: LlmGenerateInput[] }): LlmProvider {
  return {
    generate: async (input) => {
      opts.calls?.push(input);
      if (opts.error !== undefined) throw opts.error;
      const generation: LlmGeneration = {
        content: "A condensed study summary of the material.",
        model: input.model,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        stopReason: "end_turn",
      };
      return generation;
    },
    stream: () => {
      throw new Error("stream should not be called by the summarize route");
    },
  };
}

function fakeCache(
  over: { hit?: SummaryCacheEntry | null; getError?: Error; setError?: Error } = {},
) {
  let stored: SummaryCacheEntry | null = over.hit ?? null;
  const sets: SummaryCacheEntry[] = [];
  return {
    async get() {
      if (over.getError) throw over.getError;
      return stored;
    },
    async set(_key: string, entry: SummaryCacheEntry) {
      if (over.setError) throw over.setError;
      sets.push(entry);
      stored = entry;
    },
    sets,
  } as SummaryCache & { sets: SummaryCacheEntry[] };
}

function buildSummaryApp(
  over: {
    provider?: LlmProvider | null;
    database?: Database;
    cache?: SummaryCache;
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
    aiSummaryRoutes({
      database: over.database ?? fakeDatabase({ material: null }).database,
      provider: over.provider === undefined ? fakeProvider({}) : over.provider,
      cache: over.cache ?? fakeCache(),
      modelOverrides: over.modelOverrides,
    }),
  );
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const summarizeUrl = `/api/ai/students/${STUDENT_ID}/summarize`;

async function postSummary(
  app: OpenAPIHono<AppEnv>,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(summarizeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const readyMaterial = { id: MATERIAL_ID, title: "Biology", ingest_status: "ready" };

describe("POST /api/ai/students/{studentId}/summarize", () => {
  test("a null provider answers 503 AI_LLM_DISABLED", async () => {
    const app = buildSummaryApp({ provider: null });

    const res = await postSummary(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_DISABLED);
  });

  test("a material the school cannot see answers 404 RESOURCE_NOT_FOUND", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildSummaryApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ material: null }).database,
    });

    const res = await postSummary(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    expect(calls).toHaveLength(0);
  });

  test("a mid-ingestion material answers 422 VALIDATION_FAILED", async () => {
    const app = buildSummaryApp({
      database: fakeDatabase({
        material: { id: MATERIAL_ID, title: "Biology", ingest_status: "processing" },
        chunks: [],
      }).database,
    });

    const res = await postSummary(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("a ready material with no ingested text answers 422 VALIDATION_FAILED", async () => {
    const app = buildSummaryApp({
      database: fakeDatabase({ material: readyMaterial, chunks: [] }).database,
    });

    const res = await postSummary(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("a cache miss generates through the small tier and commits the actual tokens", async () => {
    const calls: LlmGenerateInput[] = [];
    const handle = quotaHandle();
    const cache = fakeCache();
    const { database, queries } = fakeDatabase({ material: readyMaterial, chunks: readyChunks() });
    const app = buildSummaryApp({
      provider: fakeProvider({ calls }),
      database,
      cache,
      handle,
    });

    const res = await postSummary(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as {
      summary: string;
      length: string;
      model: string;
      tier: string;
      feature: string;
      cached: boolean;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      sources: {
        chunk_id: string;
        chunk_index: number;
        page_number: number | null;
        section_title: string | null;
        order: number;
      }[];
    };

    expect(res.status).toBe(200);
    expect(body.summary).toBe("A condensed study summary of the material.");
    expect(body.length).toBe("standard");
    expect(body.model).toBe(AI_LLM_DEFAULT_SMALL_MODEL);
    expect(body.tier).toBe("small");
    expect(body.feature).toBe("summary");
    expect(body.cached).toBe(false);
    expect(body.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });

    // The provider was asked for the routed small model, the hardened summary prompt, and the
    // breaker key; the user turn carries one numbered source block per chunk.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: AI_LLM_DEFAULT_SMALL_MODEL,
      userId: USER_ID,
      circuitKey: SCHOOL_ID,
    });
    expect(calls[0]!.prompt).toContain(`<source-`);
    expect(calls[0]!.prompt).toContain(`id="1"`);
    expect(calls[0]!.prompt).toContain(`id="2"`);
    expect(calls[0]!.system).toContain("Treat every <source-");
    expect(calls[0]!.system).toContain("Do not omit a source.");

    // The section/page anchors are echoed back, numbered 1..N in chunk order.
    expect(body.sources).toHaveLength(2);
    expect(body.sources[0]).toEqual({
      chunk_id: "10000000-0000-4000-8000-000000000001",
      chunk_index: 0,
      page_number: 1,
      section_title: "Intro",
      order: 1,
    });
    expect(body.sources[1]).toMatchObject({ chunk_index: 1, order: 2 });

    // The provider-reported usage was committed, and the durable ledger ran inside the tenant
    // transaction (the fake tx records every statement it answered).
    expect(handle.commits).toEqual([30]);
    expect(queries.some((q) => q.includes("FROM app.ai_subscriptions"))).toBe(true);
    expect(queries.some((q) => q.includes("upsert_ai_usage_tokens"))).toBe(true);

    // The cache was primed with the generated summary, its length preset, and its anchors.
    expect(cache.sets).toHaveLength(1);
    expect(cache.sets[0]!.summary).toBe("A condensed study summary of the material.");
    expect(cache.sets[0]!.length).toBe("standard");
    expect(cache.sets[0]!.sources).toEqual(body.sources);
  });

  test("a model override replaces the small tier's model id", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildSummaryApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
      modelOverrides: { small: "claude-haiku-custom" },
    });

    const res = await postSummary(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { model: string; tier: string };

    expect(res.status).toBe(200);
    expect(body.model).toBe("claude-haiku-custom");
    expect(calls[0]!.model).toBe("claude-haiku-custom");
  });

  test("a cache hit is served with zero tokens and no provider call", async () => {
    const calls: LlmGenerateInput[] = [];
    const handle = quotaHandle();
    const entry: SummaryCacheEntry = {
      summary: "Cached summary.",
      model: AI_LLM_DEFAULT_SMALL_MODEL,
      tier: "small",
      length: "standard",
      sources: [
        {
          chunk_id: "10000000-0000-4000-8000-000000000001",
          chunk_index: 0,
          page_number: 1,
          section_title: "Intro",
          order: 1,
        },
      ],
    };
    const app = buildSummaryApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
      cache: fakeCache({ hit: entry }),
      handle,
    });

    const res = await postSummary(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as {
      summary: string;
      cached: boolean;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      sources: SummaryCacheSource[];
    };

    expect(res.status).toBe(200);
    expect(body.cached).toBe(true);
    expect(body.summary).toBe("Cached summary.");
    expect(body.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(body.sources).toEqual(entry.sources);

    // The reservation was settled with a zero-token commit, and the provider was never touched.
    expect(handle.commits).toEqual([0]);
    expect(calls).toHaveLength(0);
  });

  test("a cache get failure degrades to regenerating, not an error", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildSummaryApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
      cache: fakeCache({ getError: new Error("redis down") }),
    });

    const res = await postSummary(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { cached: boolean };

    expect(res.status).toBe(200);
    expect(body.cached).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("a cache set failure still answers 200; the cache is an accelerator", async () => {
    const app = buildSummaryApp({
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
      cache: fakeCache({ setError: new Error("redis down") }),
    });

    const res = await postSummary(app, { materialId: MATERIAL_ID });

    expect(res.status).toBe(200);
  });

  test("a provider 4xx answers 503 AI_LLM_REQUEST_REJECTED without Retry-After", async () => {
    const provider = fakeProvider({
      error: new LlmProviderError("prompt violates content policy", 400, "http", {
        error: { message: "prompt violates content policy" },
      }),
    });
    const app = buildSummaryApp({
      provider,
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
    });

    const res = await postSummary(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_REQUEST_REJECTED);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  test("a provider timeout answers 503 AI_LLM_UNAVAILABLE with Retry-After", async () => {
    const provider = fakeProvider({ error: new LlmProviderError("timed out", 504, "timeout") });
    const app = buildSummaryApp({
      provider,
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
    });

    const res = await postSummary(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_UNAVAILABLE);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  test("a malformed or missing materialId answers 400", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildSummaryApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
    });

    const badId = await postSummary(app, { materialId: "not-a-uuid" });
    expect(badId.status).toBe(400);

    const missing = await postSummary(app, {});
    expect(missing.status).toBe(400);

    const noBody = await app.request(summarizeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(noBody.status).toBe(400);

    expect(calls).toHaveLength(0);
  });

  test("an unknown length preset answers 400", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildSummaryApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
    });

    const res = await postSummary(app, { materialId: MATERIAL_ID, length: "medium" });

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("each length preset generates once and is then served from its own cache entry", async () => {
    const calls: LlmGenerateInput[] = [];
    // A key-aware cache, unlike the shared fakeCache(): the route must key each preset separately
    // for a preset switch to be a zero-token hit.
    const store = new Map<string, SummaryCacheEntry>();
    const keyed: SummaryCache = {
      get: async (key) => store.get(key) ?? null,
      set: async (key, entry) => void store.set(key, entry),
    };
    const handle = quotaHandle();
    const app = buildSummaryApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
      cache: keyed,
      handle,
    });

    const brief = (await (
      await postSummary(app, { materialId: MATERIAL_ID, length: "brief" })
    ).json()) as {
      length: string;
      cached: boolean;
    };
    const detailed = (await (
      await postSummary(app, { materialId: MATERIAL_ID, length: "detailed" })
    ).json()) as { length: string; cached: boolean };

    expect(brief).toMatchObject({ length: "brief", cached: false });
    expect(detailed).toMatchObject({ length: "detailed", cached: false });
    expect(calls).toHaveLength(2);
    expect(store.size).toBe(2);

    // Switching back to a preset already generated is a cache hit: no new provider call, zero tokens.
    const briefAgain = (await (
      await postSummary(app, { materialId: MATERIAL_ID, length: "brief" })
    ).json()) as { length: string; cached: boolean };

    expect(briefAgain).toMatchObject({ length: "brief", cached: true });
    expect(calls).toHaveLength(2);
    expect(handle.commits).toEqual([30, 30, 0]);
  });
});
