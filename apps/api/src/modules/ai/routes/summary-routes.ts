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
import { getAiQuota } from "../gate/entitlement-gate";
import { throwLlmError } from "../llm/errors";
import { AI_FEATURES, AI_MODEL_TIERS, resolveAiModel } from "../llm/routing";
import {
  summaryCacheKey,
  summaryFingerprint,
  type SummaryCache,
  type SummaryCacheEntry,
} from "../summary/cache";
import { loadSummaryMaterial } from "../summary/materials";
import { assembleSummaryPrompt } from "../summary/prompt";
import { recordDurableUsage, splitByTier } from "../usage/durable";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { LlmProvider } from "../llm/provider";
import type { AiModelTier } from "../llm/routing";
import type { Context } from "hono";

/**
 * Study-material summarizer route: `POST /api/ai/students/{studentId}/summarize`.
 *
 * The route loads the requested material's ingested text chunks (section-anchored, in order),
 * hands them to the routed small tier as numbered sources (the same hardened prompt assembly the
 * ask route uses — see `summary/prompt.ts`), and returns the model's condensation plus the
 * machine-readable source anchors so a client can render "based on page N, 'Section'".
 *
 * Summaries are deterministic per material for a given student, so they are cached in Redis
 * (`summary/cache.ts`): a repeat request is served from cache with a zero-token commit against
 * quota, and only a miss spends tokens. The cache is an accelerator — a miss, eviction, or Redis
 * error all degrade to regenerating.
 *
 * ## Error surface
 *
 * The ST-155 gate's 403/402/429 apply to the whole `/api/ai/*` surface. On top of that: a null
 * provider (kill switch off) -> 503 AI_LLM_DISABLED; a material the student's school cannot see
 * or that has no ingested text -> 404 RESOURCE_NOT_FOUND; a material still mid-ingestion ->
 * 422 VALIDATION_FAILED so a client can distinguish "try later" from "does not exist"; and the
 * shared provider failure taxonomy (503 AI_LLM_UNAVAILABLE / AI_LLM_REQUEST_REJECTED).
 *
 * Cost flow mirrors the generate route: the material load runs in a short tenant transaction, the
 * provider call runs outside any transaction, and the provider-reported tokens are recorded
 * durably and committed against quota in a second short tenant transaction.
 */

const summaryUsageSchema = z.object({
  /** Input tokens (prompt + any cached prefix) reported by the provider. */
  inputTokens: z.number().int().nonnegative(),
  /** Output tokens reported by the provider. */
  outputTokens: z.number().int().nonnegative(),
  /** input + output; the tokens committed against this student's AI quota. */
  totalTokens: z.number().int().nonnegative(),
});

const summarySourceSchema = z.object({
  /** `app.material_chunks.id` of the chunk this source was rendered from. */
  chunk_id: z.string().uuid(),
  /** The chunk's ordinal within its material (`chunk_index`), 0-based like the table. */
  chunk_index: z.number().int().nonnegative(),
  page_number: z.number().int().nullable(),
  section_title: z.string().nullable(),
  /** The source's 1-based position in the summary prompt; the `id` the model was told. */
  order: z.number().int().min(1),
});

const summaryResponseSchema = z.object({
  /** The model's condensation of the material's ingested text. */
  summary: z.string(),
  /** The model id that actually answered (the routed tier's id). */
  model: z.string(),
  /** The routing-tier that served this feature: always "small" (summary is a small-tier feature). */
  tier: z.enum(AI_MODEL_TIERS),
  /** The surface this generation served: always "summary". */
  feature: z.enum(AI_FEATURES),
  /** True when served from the cache; a cached response commits zero tokens. */
  cached: z.boolean(),
  /** Provider-reported tokens. All zeros on a cache hit. */
  usage: summaryUsageSchema,
  /** The numbered sources the summary was grounded on, in prompt order. */
  sources: z.array(summarySourceSchema),
});

/** This surface is always the `summary` feature; typed as the feature union so c.json's generic widens correctly. */
const SUMMARY_FEATURE: (typeof AI_FEATURES)[number] = "summary";

const summaryBodySchema = z.object({
  materialId: z.string().uuid().openapi({
    description: "The learning material to summarize.",
    example: "0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12",
  }),
});

const summaryParamsSchema = z.object({
  studentId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "studentId", in: "path" },
      description: "The student whose AI quota the summary draws on.",
    }),
});

const summaryRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/summarize",
  tags: ["AI"],
  operationId: "summarizeMaterial",
  summary: "Summarize a study material",
  description:
    "Loads the material's ingested text chunks, routes the summarization through the small " +
    "(fast, cheap) model tier, and returns the condensation with its section/page anchors. " +
    "Summaries are deterministic per student and material, so repeat requests are served from a " +
    "Redis cache with zero token cost. Consumes the same gate as every other AI surface " +
    "(403/402/429). Refuses with 404 RESOURCE_NOT_FOUND for a material the school cannot see or " +
    "with no ingested text, 422 VALIDATION_FAILED while the material is still mid-ingestion, 503 " +
    "AI_LLM_DISABLED when the LLM plane is turned off, and the shared provider failure taxonomy " +
    "(503 AI_LLM_UNAVAILABLE with Retry-After / 503 AI_LLM_REQUEST_REJECTED).",
  security: [{ bearerAuth: [] }],
  request: {
    params: summaryParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: summaryBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The generated summary, the serving model and tier, and the token usage.",
        schema: summaryResponseSchema,
      },
    },
    [400, 401, 402, 403, 404, 422, 429, 500, 503],
  ),
});

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/** Render one chunk as the machine-readable source anchor the response carries. */
function sourceAnchor(
  chunk: { id: string; chunkIndex: number; pageNumber: number | null; sectionTitle: string | null },
  order: number,
) {
  return {
    chunk_id: chunk.id,
    chunk_index: chunk.chunkIndex,
    page_number: chunk.pageNumber,
    section_title: chunk.sectionTitle,
    order,
  };
}

export function aiSummaryRoutes(deps: {
  database: Database;
  /**
   * The configured LLM provider, or null when the AI_LLM_ENABLED kill switch is off. Null answers
   * 503 AI_LLM_DISABLED at request time; the route still registers so the published contract does
   * not depend on a deployment's environment (the storage-upload precedent).
   */
  provider: LlmProvider | null;
  /** Redis-backed summary cache. Injected so tests can substitute an in-memory fake. */
  cache: SummaryCache;
  /** Environment overrides for the routing table's model ids (`AI_LLM_SMALL_MODEL`). */
  modelOverrides?: Partial<Record<AiModelTier, string>>;
}): OpenAPIHono<AppEnv> {
  const { database, provider, cache, modelOverrides = {} } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // The audit-coverage gate (tests/audit-coverage.test.ts) requires every mutating route to declare
  // its audit intent. This POST's one write is the metered student's own usage ledger; the
  // declaration is metadata (auditAction never writes a row) — the storage-upload precedent.
  routes.use("/api/ai/students/{studentId}/summarize", auditAction("update", "ai_usage_meters"));

  routes.openapi(summaryRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const { materialId } = c.req.valid("json");
    const quota = getAiQuota(c);

    if (!provider) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.AI_LLM_DISABLED,
        getLocalizedMessage(
          ERROR_CODES.AI_LLM_DISABLED,
          (c.get("locale") ?? "en") as SupportedLocale,
        ),
      );
    }

    const routed = resolveAiModel("summary", modelOverrides);

    const loaded = await withTenantTx(database, tenantFrom(c), (tx) =>
      loadSummaryMaterial(tx, materialId),
    );

    if (loaded.status === "not_found") {
      throw new CodedHttpException(
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        getLocalizedMessage(
          ERROR_CODES.RESOURCE_NOT_FOUND,
          (c.get("locale") ?? "en") as SupportedLocale,
        ),
      );
    }

    if (loaded.status === "not_ready" || loaded.material.chunks.length === 0) {
      throw new CodedHttpException(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        getLocalizedMessage(
          ERROR_CODES.VALIDATION_FAILED,
          (c.get("locale") ?? "en") as SupportedLocale,
        ),
      );
    }

    const fingerprint = summaryFingerprint(materialId, loaded.material.chunks);
    const cacheKey = summaryCacheKey(studentId, materialId, fingerprint);

    // Cache is an accelerator, never a dependency: any get failure is a miss, and the set below is
    // fire-and-forget, so a Redis hiccup costs a regeneration, not an error.
    let cached: SummaryCacheEntry | null;
    try {
      cached = await cache.get(cacheKey);
    } catch {
      cached = null;
    }

    if (cached) {
      await quota.commit(0);
      return c.json(
        {
          summary: cached.summary,
          model: cached.model,
          tier: cached.tier,
          feature: SUMMARY_FEATURE,
          cached: true,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          sources: cached.sources,
        },
        200,
      );
    }

    try {
      const prompt = assembleSummaryPrompt(loaded.material.chunks, loaded.material.title);
      const generation = await provider.generate({
        model: routed.model,
        prompt: prompt.user,
        system: prompt.system,
        userId: auth.userId,
        circuitKey: auth.schoolId,
      });

      // The provider call deliberately happened outside the transaction above; this short write is
      // all the transaction holds.
      await withTenantTx(database, tenantFrom(c), async (tx) => {
        await recordDurableUsage(
          tx,
          auth.schoolId,
          studentId,
          splitByTier(generation.usage.totalTokens, routed.tier),
        );
      });

      await quota.commit(generation.usage.totalTokens);

      const sources = loaded.material.chunks.map((chunk, index) => sourceAnchor(chunk, index + 1));
      cache
        .set(cacheKey, {
          summary: generation.content,
          model: generation.model,
          tier: routed.tier,
          sources,
        })
        .catch((err: unknown) => {
          c.get("log")?.warn(
            { err, school_id: auth.schoolId, student_id: studentId, material_id: materialId },
            "summary cache set failed",
          );
        });

      return c.json(
        {
          summary: generation.content,
          model: generation.model,
          tier: routed.tier,
          feature: SUMMARY_FEATURE,
          cached: false,
          usage: generation.usage,
          sources,
        },
        200,
      );
    } catch (error) {
      throwLlmError(c, error);
    }
  });

  return routes;
}
