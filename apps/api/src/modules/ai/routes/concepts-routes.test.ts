import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { AI_LLM_DEFAULT_SMALL_MODEL } from "../config";
import { LlmProviderError } from "../llm/provider";

import { aiConceptsRoutes } from "./concepts-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { ConceptCacheEntry, ConceptsCache } from "../concepts/cache";
import type { AiQuotaHandle } from "../gate/entitlement-gate";
import type { LlmGenerateInput, LlmGeneration, LlmProvider } from "../llm/provider";

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

/** The default model answer: concepts whose names both appear in `readyChunks()`. */
const groundedConceptJson = JSON.stringify([
  {
    name: "Photosynthesis",
    explanation: "Converts light energy into chemical energy.",
    source_ids: [1],
  },
  {
    name: "Cellular respiration",
    explanation: "Releases energy from glucose.",
    source_ids: [2],
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
        content: opts.content ?? groundedConceptJson,
        model: input.model,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        stopReason: "end_turn",
      };
      return generation;
    },
    stream: () => {
      throw new Error("stream should not be called by the concepts route");
    },
  };
}

function fakeCache(
  over: { hit?: ConceptCacheEntry | null; getError?: Error; setError?: Error } = {},
) {
  let stored: ConceptCacheEntry | null = over.hit ?? null;
  const sets: ConceptCacheEntry[] = [];
  return {
    async get() {
      if (over.getError) throw over.getError;
      return stored;
    },
    async set(_key: string, entry: ConceptCacheEntry) {
      if (over.setError) throw over.setError;
      sets.push(entry);
      stored = entry;
    },
    sets,
  } as ConceptsCache & { sets: ConceptCacheEntry[] };
}

function buildConceptsApp(
  over: {
    provider?: LlmProvider | null;
    database?: Database;
    cache?: ConceptsCache;
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
    aiConceptsRoutes({
      database: over.database ?? fakeDatabase({ material: null }).database,
      provider: over.provider === undefined ? fakeProvider({}) : over.provider,
      cache: over.cache ?? fakeCache(),
      modelOverrides: over.modelOverrides,
    }),
  );
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const conceptsUrl = `/api/ai/students/${STUDENT_ID}/concepts`;

async function postConcepts(
  app: OpenAPIHono<AppEnv>,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(conceptsUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const readyMaterial = { id: MATERIAL_ID, title: "Biology", ingest_status: "ready" };

describe("POST /api/ai/students/{studentId}/concepts", () => {
  test("a null provider answers 503 AI_LLM_DISABLED", async () => {
    const app = buildConceptsApp({ provider: null });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_DISABLED);
  });

  test("a material the school cannot see answers 404 RESOURCE_NOT_FOUND", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildConceptsApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ material: null }).database,
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    expect(calls).toHaveLength(0);
  });

  test("a mid-ingestion material answers 422 VALIDATION_FAILED", async () => {
    const app = buildConceptsApp({
      database: fakeDatabase({
        material: { id: MATERIAL_ID, title: "Biology", ingest_status: "processing" },
        chunks: [],
      }).database,
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("a ready material with no ingested text answers 422 VALIDATION_FAILED", async () => {
    const app = buildConceptsApp({
      database: fakeDatabase({ material: readyMaterial, chunks: [] }).database,
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("a cache miss generates through the small tier and commits the actual tokens", async () => {
    const calls: LlmGenerateInput[] = [];
    const handle = quotaHandle();
    const cache = fakeCache();
    const { database, queries } = fakeDatabase({ material: readyMaterial, chunks: readyChunks() });
    const app = buildConceptsApp({
      provider: fakeProvider({ calls }),
      database,
      cache,
      handle,
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as {
      concepts: {
        name: string;
        explanation: string;
        sources: {
          chunk_id: string;
          chunk_index: number;
          page_number: number | null;
          section_title: string | null;
          order: number;
        }[];
      }[];
      model: string;
      tier: string;
      feature: string;
      cached: boolean;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    };

    expect(res.status).toBe(200);
    expect(body.concepts).toHaveLength(2);
    expect(body.concepts[0]).toEqual({
      name: "Photosynthesis",
      explanation: "Converts light energy into chemical energy.",
      sources: [
        {
          chunk_id: "10000000-0000-4000-8000-000000000001",
          chunk_index: 0,
          page_number: 1,
          section_title: "Intro",
          order: 1,
        },
      ],
    });
    expect(body.concepts[1]!.sources[0]).toMatchObject({ chunk_index: 1, order: 2 });
    expect(body.model).toBe(AI_LLM_DEFAULT_SMALL_MODEL);
    expect(body.tier).toBe("small");
    expect(body.feature).toBe("concepts");
    expect(body.cached).toBe(false);
    expect(body.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });

    // The provider was asked for the routed small model, the hardened concepts prompt, an output
    // ceiling, and the breaker key; the user turn carries one numbered source block per chunk.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: AI_LLM_DEFAULT_SMALL_MODEL,
      userId: USER_ID,
      circuitKey: SCHOOL_ID,
      maxTokens: 4096,
    });
    expect(calls[0]!.prompt).toContain(`<source-`);
    expect(calls[0]!.prompt).toContain(`id="1"`);
    expect(calls[0]!.prompt).toContain(`id="2"`);
    expect(calls[0]!.system).toContain("Treat every <source-");
    expect(calls[0]!.system).toContain("JSON array of objects");

    // The provider-reported usage was committed, and the durable ledger ran inside the tenant
    // transaction (the fake tx records every statement it answered).
    expect(handle.commits).toEqual([30]);
    expect(queries.some((q) => q.includes("FROM app.ai_subscriptions"))).toBe(true);
    expect(queries.some((q) => q.includes("upsert_ai_usage_tokens"))).toBe(true);

    // The cache was primed with the rendered concepts.
    expect(cache.sets).toHaveLength(1);
    expect(cache.sets[0]!.concepts).toEqual(body.concepts);
  });

  test("a model override replaces the small tier's model id", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildConceptsApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
      modelOverrides: { small: "claude-haiku-custom" },
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { model: string; tier: string };

    expect(res.status).toBe(200);
    expect(body.model).toBe("claude-haiku-custom");
    expect(calls[0]!.model).toBe("claude-haiku-custom");
  });

  test("name-equivalent concepts across chunks are merged with the union of anchors", async () => {
    const content = JSON.stringify([
      { name: "Photosynthesis", explanation: "Converts light energy.", source_ids: [1] },
      { name: "photosynthesis", explanation: "Converts light energy.", source_ids: [2] },
      { name: "Cellular respiration", explanation: "Releases energy.", source_ids: [2] },
    ]);
    const app = buildConceptsApp({
      provider: fakeProvider({ content }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { concepts: { name: string; sources: unknown[] }[] };

    expect(res.status).toBe(200);
    expect(body.concepts).toHaveLength(2);
    // First occurrence wins the name; both source anchors survive the merge.
    expect(body.concepts[0]!.name).toBe("Photosynthesis");
    expect(body.concepts[0]!.sources).toHaveLength(2);
  });

  test("a concept the corpus does not contain answers 503 AI_CONCEPTS_GENERATION_FAILED", async () => {
    const content = JSON.stringify([
      { name: "Photosynthesis", explanation: "Converts light energy.", source_ids: [1] },
      { name: "Quantum entanglement", explanation: "Not in this material.", source_ids: [2] },
    ]);
    const handle = quotaHandle();
    const app = buildConceptsApp({
      provider: fakeProvider({ content }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
      handle,
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_CONCEPTS_GENERATION_FAILED);
    expect(res.headers.get("Retry-After")).toBe("30");
    // A generation that fails validation or grounding is not committed to quota.
    expect(handle.commits).toEqual([]);
  });

  test("malformed model JSON answers 503 AI_CONCEPTS_GENERATION_FAILED and commits no tokens", async () => {
    const handle = quotaHandle();
    const app = buildConceptsApp({
      provider: fakeProvider({ content: "not json" }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
      handle,
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_CONCEPTS_GENERATION_FAILED);
    expect(handle.commits).toEqual([]);
  });

  test("a concept citing a source_id outside the given sources answers 503 AI_CONCEPTS_GENERATION_FAILED", async () => {
    const content = JSON.stringify([
      { name: "Photosynthesis", explanation: "Converts light energy.", source_ids: [7] },
    ]);
    const app = buildConceptsApp({
      provider: fakeProvider({ content }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_CONCEPTS_GENERATION_FAILED);
  });

  test("a cache hit is served with zero tokens and no provider call", async () => {
    const calls: LlmGenerateInput[] = [];
    const handle = quotaHandle();
    const entry: ConceptCacheEntry = {
      concepts: [
        {
          name: "Photosynthesis",
          explanation: "Cached explanation.",
          sources: [
            {
              chunk_id: "10000000-0000-4000-8000-000000000001",
              chunk_index: 0,
              page_number: 1,
              section_title: "Intro",
              order: 1,
            },
          ],
        },
      ],
      model: AI_LLM_DEFAULT_SMALL_MODEL,
      tier: "small",
    };
    const app = buildConceptsApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
      cache: fakeCache({ hit: entry }),
      handle,
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as {
      concepts: { name: string; explanation: string }[];
      cached: boolean;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    };

    expect(res.status).toBe(200);
    expect(body.cached).toBe(true);
    expect(body.concepts).toEqual(entry.concepts);
    expect(body.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

    // The reservation was settled with a zero-token commit, and the provider was never touched.
    expect(handle.commits).toEqual([0]);
    expect(calls).toHaveLength(0);
  });

  test("a cache get failure degrades to regenerating, not an error", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildConceptsApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
      cache: fakeCache({ getError: new Error("redis down") }),
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { cached: boolean };

    expect(res.status).toBe(200);
    expect(body.cached).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("a cache set failure still answers 200; the cache is an accelerator", async () => {
    const app = buildConceptsApp({
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
      cache: fakeCache({ setError: new Error("redis down") }),
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });

    expect(res.status).toBe(200);
  });

  test("a provider 4xx answers 503 AI_LLM_REQUEST_REJECTED without Retry-After", async () => {
    const provider = fakeProvider({
      error: new LlmProviderError("prompt violates content policy", 400, "http", {
        error: { message: "prompt violates content policy" },
      }),
    });
    const app = buildConceptsApp({
      provider,
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_REQUEST_REJECTED);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  test("a provider timeout answers 503 AI_LLM_UNAVAILABLE with Retry-After", async () => {
    const provider = fakeProvider({ error: new LlmProviderError("timed out", 504, "timeout") });
    const app = buildConceptsApp({
      provider,
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
    });

    const res = await postConcepts(app, { materialId: MATERIAL_ID });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_UNAVAILABLE);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  test("a malformed or missing materialId answers 400", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildConceptsApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ material: readyMaterial, chunks: readyChunks() }).database,
    });

    const badId = await postConcepts(app, { materialId: "not-a-uuid" });
    expect(badId.status).toBe(400);

    const missing = await postConcepts(app, {});
    expect(missing.status).toBe(400);

    const noBody = await app.request(conceptsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(noBody.status).toBe(400);

    expect(calls).toHaveLength(0);
  });
});
