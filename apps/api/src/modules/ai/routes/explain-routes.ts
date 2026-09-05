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
import { AI_EXPLAIN_LEVELS, AI_LLM_RETRY_AFTER_SECONDS } from "../config";
import { ExplainGenerationInvalidError, firstUngroundedSentence } from "../explain/grounding";
import { loadExplainPassage } from "../explain/materials";
import { assembleExplainPrompt } from "../explain/prompt";
import { getAiQuota } from "../gate/entitlement-gate";
import { throwLlmError } from "../llm/errors";
import { AI_FEATURES, AI_MODEL_TIERS, resolveAiModel } from "../llm/routing";
import { recordDurableUsage, splitByTier } from "../usage/durable";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { LlmProvider } from "../llm/provider";
import type { AiModelTier } from "../llm/routing";
import type { Context } from "hono";

/**
 * Simplified-explanations route: `POST /api/ai/students/{studentId}/explain`.
 *
 * The route loads ONE retrieved passage (`app.material_chunks` row) by chunk id, hands it to the
 * routed large tier as a single numbered source (the same hardened prompt assembly the
 * ask/summarize routes use -- see `explain/prompt.ts`), and returns the model's rewrite in plain
 * language at the requested age-appropriate level (`elementary` / `middle` / `high`), plus the
 * machine-readable source anchor so a client can render "based on page N, 'Section'".
 *
 * The rewrite must satisfy the grounding validator (`explain/grounding.ts`): every sentence of the
 * explanation has to share at least one significant word with the passage it was handed. A sentence
 * that does not has drifted out of the source and rejects the whole generation, the same posture a
 * hallucinated concept or citation gets on the other surfaces. The route deliberately does not
 * cache: a paraphrase is only as useful as it is freshly faithful to one student's retrieval, and
 * caching a level-flavored rewrite would serve stale prose.
 *
 * ## Error surface
 *
 * The ST-155 gate's 403/402/429 apply to the whole `/api/ai/*` surface. On top of that: a null
 * provider (kill switch off) -> 503 AI_LLM_DISABLED; a chunk the student's school cannot see ->
 * 404 RESOURCE_NOT_FOUND; a chunk whose material is still mid-ingestion -> 422 VALIDATION_FAILED so
 * a client can distinguish "try later" from "does not exist"; a model response that is empty or
 * fails grounding -> 503 AI_EXPLAIN_GENERATION_FAILED with Retry-After (and, deliberately, not
 * committed to quota -- see config.ts); and the shared provider failure taxonomy (503
 * AI_LLM_UNAVAILABLE / AI_LLM_REQUEST_REJECTED).
 *
 * Cost flow mirrors the other AI routes: the passage load runs in a short tenant transaction, the
 * provider call runs outside any transaction, and the provider-reported tokens are recorded
 * durably and committed against quota in a second short tenant transaction.
 */

const explainUsageSchema = z.object({
  /** Input tokens (prompt + any cached prefix) reported by the provider. */
  inputTokens: z.number().int().nonnegative(),
  /** Output tokens reported by the provider. */
  outputTokens: z.number().int().nonnegative(),
  /** input + output; the tokens committed against this student's AI quota. */
  totalTokens: z.number().int().nonnegative(),
});

const explainSourceSchema = z.object({
  /** `app.material_chunks.id` of the chunk this explanation was rendered from. */
  chunk_id: z.string().uuid(),
  /** The chunk's parent material (`app.materials.id`). */
  material_id: z.string().uuid(),
  /** The material title, when the material has one. */
  material_title: z.string().nullable(),
  page_number: z.number().int().nullable(),
  section_title: z.string().nullable(),
  /** The source's 1-based position in the explain prompt; always 1 for the single passage. */
  order: z.number().int().min(1),
});

const explainResponseSchema = z.object({
  /** The passage rewritten in plain language at the requested level. */
  explanation: z.string(),
  /** The model id that actually answered (the routed tier's id). */
  model: z.string(),
  /** The routing-tier that served this feature: always "large" (explain is a large-tier feature). */
  tier: z.enum(AI_MODEL_TIERS),
  /** The surface this generation served: always "explain". */
  feature: z.enum(AI_FEATURES),
  /** Always false: explanations are never cached. */
  cached: z.boolean(),
  /** Provider-reported tokens. */
  usage: explainUsageSchema,
  /** The single retrieved passage the explanation is grounded on. */
  source: explainSourceSchema,
});

/** This surface is always the `explain` feature; typed as the feature union so c.json's generic widens correctly. */
const EXPLAIN_FEATURE: (typeof AI_FEATURES)[number] = "explain";

const explainBodySchema = z.object({
  chunkId: z.string().uuid().openapi({
    description: "The retrieved passage (material chunk) to rewrite in plain language.",
    example: "0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12",
  }),
  level: z.enum(AI_EXPLAIN_LEVELS).openapi({
    description: "The age-appropriate reading level the rewrite should match.",
    example: "middle",
  }),
});

const explainParamsSchema = z.object({
  studentId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "studentId", in: "path" },
      description: "The student whose AI quota the explanation draws on.",
    }),
});

const explainRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/explain",
  tags: ["AI"],
  operationId: "explainPassage",
  summary: "Explain a passage in plain language",
  description:
    "Loads one retrieved passage (a material chunk) by id, routes the rewrite through the large " +
    "model tier, and returns the passage explained in plain language at the requested age-appropriate " +
    "level (elementary / middle / high). Every sentence of the explanation must be grounded in the " +
    "passage's vocabulary or the whole generation is refused. Consumes the same gate as every other " +
    "AI surface (403/402/429). Refuses with 404 RESOURCE_NOT_FOUND for a chunk the school cannot see, " +
    "422 VALIDATION_FAILED while the chunk's material is still mid-ingestion, 503 AI_LLM_DISABLED " +
    "when the LLM plane is turned off, 503 AI_EXPLAIN_GENERATION_FAILED when the model's output is " +
    "empty or grounds poorly, and the shared provider failure taxonomy (503 AI_LLM_UNAVAILABLE with " +
    "Retry-After / 503 AI_LLM_REQUEST_REJECTED).",
  security: [{ bearerAuth: [] }],
  request: {
    params: explainParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: explainBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description:
          "The plain-language explanation, the serving model and tier, and the token usage.",
        schema: explainResponseSchema,
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

export function aiExplainRoutes(deps: {
  database: Database;
  /**
   * The configured LLM provider, or null when the AI_LLM_ENABLED kill switch is off. Null answers
   * 503 AI_LLM_DISABLED at request time; the route still registers so the published contract does
   * not depend on a deployment's environment (the storage-upload precedent).
   */
  provider: LlmProvider | null;
  /** Environment overrides for the routing table's model ids (`AI_LLM_LARGE_MODEL`). */
  modelOverrides?: Partial<Record<AiModelTier, string>>;
}): OpenAPIHono<AppEnv> {
  const { database, provider, modelOverrides = {} } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // The audit-coverage gate (tests/audit-coverage.test.ts) requires every mutating route to declare
  // its audit intent. This POST's one write is the metered student's own usage ledger; the
  // declaration is metadata (auditAction never writes a row) — the storage-upload precedent.
  routes.use("/api/ai/students/:studentId/explain", auditAction("update", "ai_usage_meters"));

  routes.openapi(explainRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const { chunkId, level } = c.req.valid("json");
    const quota = getAiQuota(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;

    if (!provider) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.AI_LLM_DISABLED,
        getLocalizedMessage(ERROR_CODES.AI_LLM_DISABLED, locale),
      );
    }

    const routed = resolveAiModel("explain", modelOverrides);

    const loaded = await withTenantTx(database, tenantFrom(c), (tx) =>
      loadExplainPassage(tx, chunkId),
    );

    if (loaded.status === "not_found") {
      throw new CodedHttpException(
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        getLocalizedMessage(ERROR_CODES.RESOURCE_NOT_FOUND, locale),
      );
    }

    if (loaded.status === "not_ready") {
      throw new CodedHttpException(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        getLocalizedMessage(ERROR_CODES.VALIDATION_FAILED, locale),
      );
    }

    try {
      const prompt = assembleExplainPrompt(loaded.chunk, level);
      const generation = await provider.generate({
        model: routed.model,
        prompt: prompt.user,
        system: prompt.system,
        userId: auth.userId,
        circuitKey: auth.schoolId,
      });

      // Malformed model output is rejected here, before anything is committed to quota -- see
      // config.ts for why this does not retry server-side.
      if (generation.content.trim() === "") {
        throw new ExplainGenerationInvalidError("explanation output was empty");
      }
      const ungroundedSentence = firstUngroundedSentence(generation.content, loaded.chunk.content);
      if (ungroundedSentence !== null) {
        throw new ExplainGenerationInvalidError(
          `explanation failed grounding: sentence "${ungroundedSentence}" shares no source vocabulary`,
        );
      }

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

      return c.json(
        {
          explanation: generation.content,
          model: generation.model,
          tier: routed.tier,
          feature: EXPLAIN_FEATURE,
          cached: false,
          usage: generation.usage,
          source: {
            chunk_id: loaded.chunk.id,
            material_id: loaded.chunk.materialId,
            material_title: loaded.chunk.materialTitle,
            page_number: loaded.chunk.pageNumber,
            section_title: loaded.chunk.sectionTitle,
            order: 1,
          },
        },
        200,
      );
    } catch (error) {
      if (error instanceof ExplainGenerationInvalidError) {
        c.get("log")?.warn(
          { err: error, school_id: auth.schoolId, student_id: studentId },
          "explain generation output failed validation or grounding",
        );
        c.header("Retry-After", String(AI_LLM_RETRY_AFTER_SECONDS));
        throw new CodedHttpException(
          503,
          ERROR_CODES.AI_EXPLAIN_GENERATION_FAILED,
          getLocalizedMessage(ERROR_CODES.AI_EXPLAIN_GENERATION_FAILED, locale),
        );
      }
      throwLlmError(c, error);
    }
  });

  return routes;
}
