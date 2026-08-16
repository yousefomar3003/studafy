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
import { conceptsFingerprint } from "../concepts/cache";
import { conceptsCacheKey, type ConceptCacheEntry, type ConceptsCache } from "../concepts/cache";
import { ungroundedConcepts } from "../concepts/grounding";
import { mergeConcepts } from "../concepts/merge";
import { ConceptGenerationInvalidError, parseConceptGeneration } from "../concepts/parser";
import { assembleConceptsPrompt } from "../concepts/prompt";
import {
  AI_CONCEPTS_MAX_CONCEPTS,
  AI_CONCEPTS_OUTPUT_TOKEN_BUFFER,
  AI_CONCEPTS_OUTPUT_TOKENS_CEILING,
  AI_CONCEPTS_OUTPUT_TOKENS_PER_CONCEPT,
  AI_LLM_RETRY_AFTER_SECONDS,
} from "../config";
import { getAiQuota } from "../gate/entitlement-gate";
import { throwLlmError } from "../llm/errors";
import { AI_FEATURES, AI_MODEL_TIERS, resolveAiModel } from "../llm/routing";
import { loadSummaryMaterial } from "../summary/materials";
import { recordDurableUsage } from "../usage/durable";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { LlmProvider } from "../llm/provider";
import type { AiModelTier } from "../llm/routing";
import type { Context } from "hono";

/**
 * Key-concept extraction route: `POST /api/ai/students/{studentId}/concepts`.
 *
 * The route loads the requested material's ingested text chunks (the same single-material loader
 * and input budgets the summarizer uses), hands them to the routed small tier as numbered sources
 * (the same hardened prompt assembly the ask/summarize routes use -- see `concepts/prompt.ts`),
 * and returns the deduplicated concept list, each concept carrying the machine-readable source
 * anchors it is grounded on.
 *
 * The model's JSON output is validated against the concepts schema (`concepts/schema.ts` via
 * `concepts/parser.ts`), name-equivalent duplicates are merged deterministically
 * (`concepts/merge.ts`), and every concept must pass the grounding validator (`concepts/grounding.ts`)
 * -- a concept whose name appears in none of the chunks it cites is a hallucination and rejects the
 * whole generation, the same posture a hallucinated citation gets on quiz and flashcard
 * generation.
 *
 * Concepts are deterministic per material for a given student, so they are cached in Redis
 * (`concepts/cache.ts`): a repeat request is served from cache with a zero-token commit against
 * quota, and only a miss spends tokens. The cache is an accelerator -- a miss, eviction, or Redis
 * error all degrade to regenerating.
 *
 * ## Error surface
 *
 * The ST-155 gate's 403/402/429 apply to the whole `/api/ai/*` surface. On top of that: a null
 * provider (kill switch off) -> 503 AI_LLM_DISABLED; a material the student's school cannot see
 * or that has no ingested text -> 404 RESOURCE_NOT_FOUND; a material still mid-ingestion ->
 * 422 VALIDATION_FAILED so a client can distinguish "try later" from "does not exist"; a model
 * response that fails schema validation, cites a source it was never given, or names a concept
 * that fails grounding -> 503 AI_CONCEPTS_GENERATION_FAILED with Retry-After (and, deliberately,
 * not committed to quota -- see config.ts); and the shared provider failure taxonomy (503
 * AI_LLM_UNAVAILABLE / AI_LLM_REQUEST_REJECTED).
 *
 * Cost flow mirrors the summarize route: the material load runs in a short tenant transaction, the
 * provider call runs outside any transaction, and the provider-reported tokens are recorded
 * durably and committed against quota in a second short tenant transaction.
 */

const conceptsUsageSchema = z.object({
  /** Input tokens (prompt + any cached prefix) reported by the provider. */
  inputTokens: z.number().int().nonnegative(),
  /** Output tokens reported by the provider. */
  outputTokens: z.number().int().nonnegative(),
  /** input + output; the tokens committed against this student's AI quota. */
  totalTokens: z.number().int().nonnegative(),
});

const conceptSourceSchema = z.object({
  /** `app.material_chunks.id` of the chunk this source was rendered from. */
  chunk_id: z.string().uuid(),
  /** The chunk's ordinal within its material (`chunk_index`), 0-based like the table. */
  chunk_index: z.number().int().nonnegative(),
  page_number: z.number().int().nullable(),
  section_title: z.string().nullable(),
  /** The source's 1-based position in the concepts prompt; the `id` the model was told. */
  order: z.number().int().min(1),
});

const conceptResponseSchema = z.object({
  /** The concept's name, as the sources name it. */
  name: z.string(),
  /** A one-line, faithful explanation grounded in the cited sources. */
  explanation: z.string(),
  /** Every source this concept is grounded on, in the order the model cited them. */
  sources: z.array(conceptSourceSchema).min(1),
});

const conceptsResponseSchema = z.object({
  /** The material's deduplicated key concepts, in first-mention order. */
  concepts: z.array(conceptResponseSchema),
  /** The model id that actually answered (the routed tier's id). */
  model: z.string(),
  /** The routing-tier that served this feature: always "small" (concepts is a small-tier feature). */
  tier: z.enum(AI_MODEL_TIERS),
  /** The surface this generation served: always "concepts". */
  feature: z.enum(AI_FEATURES),
  /** True when served from the cache; a cached response commits zero tokens. */
  cached: z.boolean(),
  /** Provider-reported tokens. All zeros on a cache hit. */
  usage: conceptsUsageSchema,
});

/** This surface is always the `concepts` feature; typed as the feature union so c.json's generic widens correctly. */
const CONCEPTS_FEATURE: (typeof AI_FEATURES)[number] = "concepts";

const conceptsBodySchema = z.object({
  materialId: z.string().uuid().openapi({
    description: "The learning material to extract key concepts from.",
    example: "0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12",
  }),
});

const conceptsParamsSchema = z.object({
  studentId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "studentId", in: "path" },
      description: "The student whose AI quota the extraction draws on.",
    }),
});

const conceptsRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/concepts",
  tags: ["AI"],
  operationId: "extractConcepts",
  summary: "Extract key concepts from a study material",
  description:
    "Loads the material's ingested text chunks, routes the extraction through the small " +
    "(fast, cheap) model tier, and returns the deduplicated concept list, each concept with a " +
    "one-line explanation and the source anchors it is grounded on. Every concept is validated " +
    "against the concepts schema, duplicate names are merged deterministically, and any concept " +
    "whose name appears in none of its cited chunks rejects the whole generation. Concepts are " +
    "deterministic per student and material, so repeat requests are served from a Redis cache with " +
    "zero token cost. Consumes the same gate as every other AI surface (403/402/429). Refuses with " +
    "404 RESOURCE_NOT_FOUND for a material the school cannot see or with no ingested text, 422 " +
    "VALIDATION_FAILED while the material is still mid-ingestion, 503 AI_LLM_DISABLED when the LLM " +
    "plane is turned off, 503 AI_CONCEPTS_GENERATION_FAILED when the model's output does not " +
    "validate or grounds poorly, and the shared provider failure taxonomy (503 " +
    "AI_LLM_UNAVAILABLE with Retry-After / 503 AI_LLM_REQUEST_REJECTED).",
  security: [{ bearerAuth: [] }],
  request: {
    params: conceptsParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: conceptsBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The extracted concepts, the serving model and tier, and the token usage.",
        schema: conceptsResponseSchema,
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

/** `AI_CONCEPTS_MAX_CONCEPTS` scaled by an estimated per-concept cost -- see config.ts for the reserve math. */
function conceptsMaxTokens(): number {
  return Math.min(
    AI_CONCEPTS_OUTPUT_TOKENS_CEILING,
    AI_CONCEPTS_MAX_CONCEPTS * AI_CONCEPTS_OUTPUT_TOKENS_PER_CONCEPT +
      AI_CONCEPTS_OUTPUT_TOKEN_BUFFER,
  );
}

/** Render one chunk as the machine-readable source anchor a concept's `source_id` points at. */
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

export function aiConceptsRoutes(deps: {
  database: Database;
  /**
   * The configured LLM provider, or null when the AI_LLM_ENABLED kill switch is off. Null answers
   * 503 AI_LLM_DISABLED at request time; the route still registers so the published contract does
   * not depend on a deployment's environment (the storage-upload precedent).
   */
  provider: LlmProvider | null;
  /** Redis-backed concepts cache. Injected so tests can substitute an in-memory fake. */
  cache: ConceptsCache;
  /** Environment overrides for the routing table's model ids (`AI_LLM_SMALL_MODEL`). */
  modelOverrides?: Partial<Record<AiModelTier, string>>;
}): OpenAPIHono<AppEnv> {
  const { database, provider, cache, modelOverrides = {} } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // The audit-coverage gate (tests/audit-coverage.test.ts) requires every mutating route to declare
  // its audit intent. This POST's one write is the metered student's own usage ledger; the
  // declaration is metadata (auditAction never writes a row) — the storage-upload precedent.
  routes.use("/api/ai/students/{studentId}/concepts", auditAction("update", "ai_usage_meters"));

  routes.openapi(conceptsRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const { materialId } = c.req.valid("json");
    const quota = getAiQuota(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;

    if (!provider) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.AI_LLM_DISABLED,
        getLocalizedMessage(ERROR_CODES.AI_LLM_DISABLED, locale),
      );
    }

    const routed = resolveAiModel("concepts", modelOverrides);

    const loaded = await withTenantTx(database, tenantFrom(c), (tx) =>
      loadSummaryMaterial(tx, materialId),
    );

    if (loaded.status === "not_found") {
      throw new CodedHttpException(
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        getLocalizedMessage(ERROR_CODES.RESOURCE_NOT_FOUND, locale),
      );
    }

    if (loaded.status === "not_ready" || loaded.material.chunks.length === 0) {
      throw new CodedHttpException(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        getLocalizedMessage(ERROR_CODES.VALIDATION_FAILED, locale),
      );
    }

    const fingerprint = conceptsFingerprint(materialId, loaded.material.chunks);
    const cacheKey = conceptsCacheKey(studentId, materialId, fingerprint);

    // Cache is an accelerator, never a dependency: any get failure is a miss, and the set below is
    // fire-and-forget, so a Redis hiccup costs a regeneration, not an error.
    let cached: ConceptCacheEntry | null;
    try {
      cached = await cache.get(cacheKey);
    } catch {
      cached = null;
    }

    if (cached) {
      await quota.commit(0);
      return c.json(
        {
          concepts: cached.concepts,
          model: cached.model,
          tier: cached.tier,
          feature: CONCEPTS_FEATURE,
          cached: true,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
        200,
      );
    }

    try {
      const prompt = assembleConceptsPrompt(
        loaded.material.chunks,
        loaded.material.title,
        AI_CONCEPTS_MAX_CONCEPTS,
      );
      const generation = await provider.generate({
        model: routed.model,
        prompt: prompt.user,
        system: prompt.system,
        maxTokens: conceptsMaxTokens(),
        userId: auth.userId,
        circuitKey: auth.schoolId,
      });

      // Malformed model output is rejected here, before anything is committed to quota -- see
      // config.ts for why this does not retry server-side.
      const parsed = parseConceptGeneration(generation.content, loaded.material.chunks.length);
      const concepts = mergeConcepts(parsed);
      const ungrounded = ungroundedConcepts(concepts, loaded.material.chunks);
      if (ungrounded.length > 0) {
        throw new ConceptGenerationInvalidError(
          `concepts failed grounding: ${ungrounded.map((c) => `"${c.name}"`).join(", ")}`,
        );
      }

      // The provider call deliberately happened outside the transaction above; this short write is
      // all the transaction holds.
      await withTenantTx(database, tenantFrom(c), async (tx) => {
        await recordDurableUsage(tx, auth.schoolId, studentId, generation.usage.totalTokens);
      });

      await quota.commit(generation.usage.totalTokens);

      const rendered = concepts.map((concept) => ({
        name: concept.name,
        explanation: concept.explanation,
        sources: concept.source_ids.map((id) => sourceAnchor(loaded.material.chunks[id - 1]!, id)),
      }));
      cache
        .set(cacheKey, {
          concepts: rendered,
          model: generation.model,
          tier: routed.tier,
        })
        .catch((err: unknown) => {
          c.get("log")?.warn(
            { err, school_id: auth.schoolId, student_id: studentId, material_id: materialId },
            "concepts cache set failed",
          );
        });

      return c.json(
        {
          concepts: rendered,
          model: generation.model,
          tier: routed.tier,
          feature: CONCEPTS_FEATURE,
          cached: false,
          usage: generation.usage,
        },
        200,
      );
    } catch (error) {
      if (error instanceof ConceptGenerationInvalidError) {
        c.get("log")?.warn(
          { err: error, school_id: auth.schoolId, student_id: studentId },
          "concept generation output failed validation or grounding",
        );
        c.header("Retry-After", String(AI_LLM_RETRY_AFTER_SECONDS));
        throw new CodedHttpException(
          503,
          ERROR_CODES.AI_CONCEPTS_GENERATION_FAILED,
          getLocalizedMessage(ERROR_CODES.AI_CONCEPTS_GENERATION_FAILED, locale),
        );
      }
      throwLlmError(c, error);
    }
  });

  return routes;
}
