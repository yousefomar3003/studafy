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
import { recordDurableUsage, splitByTier } from "../usage/durable";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { LlmProvider } from "../llm/provider";
import type { AiModelTier } from "../llm/routing";
import type { Context } from "hono";

/**
 * LLM gateway route (ST-164).
 *
 * `POST /api/ai/students/{studentId}/generate` is the synchronous generate surface of the LLM
 * plane. It routes the `feature` through the model-routing table (`llm/routing.ts`) to a small or
 * large tier, calls the provider once (the provider owns retries and the per-school circuit
 * breaker), records the provider's reported token usage in the durable ledger, and commits the same
 * tokens against the caller's quota. The response carries the model id and tier that actually
 * served the request so a client can surface "answered by <model>".
 *
 * Cost flow, mirroring the hybrid-retrieval route:
 *
 *   1. The ST-155 gate has already reserved `AI_LLM_MAX_RESERVE_TOKENS` for this path — the
 *      worst-case prompt + system + output ceiling the body schema allows — when the handler runs.
 *   2. The provider call runs OUTSIDE the tenant transaction: a generation can take tens of
 *      seconds, and holding a database connection for it would starve the pool.
 *   3. The actual usage (input + output tokens, reported by the provider) is recorded durably in
 *      `app.ai_usage_meters` inside a short tenant transaction.
 *   4. The same tokens are committed against the reservation. The reserve math (24,000 >= worst
 *      case) means the meter's out-of-range guard can never fire for a well-formed request.
 *
 * Error surface: the provider is null (kill switch off) -> 503 AI_LLM_DISABLED; a provider or
 * network failure (timeout, 5xx, 429, open circuit) -> 503 AI_LLM_UNAVAILABLE with Retry-After;
 * a non-transient refusal from a healthy provider (4xx: content policy, invalid model) ->
 * 503 AI_LLM_REQUEST_REJECTED, which is deliberately not Retry-After'd because retrying is futile.
 *
 * Streaming stays provider-level (see llm/provider.ts): the gate releases its hold when this
 * handler returns, which would race an SSE body still emitting. A future chat route will own that
 * reservation lifecycle.
 */

const PROMPT_MAX_CHARS = 8000;
const SYSTEM_MAX_CHARS = 8000;
const MAX_TOKENS_CEILING = 16_384;

const generateUsageSchema = z.object({
  /** Input tokens (prompt + any cached prefix) reported by the provider. */
  inputTokens: z.number().int().nonnegative(),
  /** Output tokens reported by the provider. */
  outputTokens: z.number().int().nonnegative(),
  /** input + output; the tokens committed against this student's AI quota. */
  totalTokens: z.number().int().nonnegative(),
});

const generateResponseSchema = z.object({
  /** The generated text. */
  content: z.string(),
  /** The model id that actually answered (the routed tier's id). */
  model: z.string(),
  /** The routing-tier that served this feature: "small" or "large". */
  tier: z.enum(AI_MODEL_TIERS),
  /** The surface this generation served, echoed from the request. */
  feature: z.enum(AI_FEATURES),
  usage: generateUsageSchema,
});

const generateBodySchema = z.object({
  feature: z.enum(AI_FEATURES).openapi({
    description:
      "The AI surface being served. Routes to a model tier: ask/exam use the large (reasoning) " +
      "tier, summary/flashcards the small (fast, cheap) tier.",
    example: "ask",
  }),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(PROMPT_MAX_CHARS)
    .openapi({
      description: `The user's prompt. Up to ${PROMPT_MAX_CHARS} characters.`,
      example: "Explain how photosynthesis converts light energy.",
    }),
  system: z
    .string()
    .trim()
    .max(SYSTEM_MAX_CHARS)
    .optional()
    .openapi({
      description: `Optional system hint, sent as the request's system field. Up to ${SYSTEM_MAX_CHARS} characters.`,
      example: "Answer in plain language for a high-school student.",
    }),
  maxTokens: z.number().int().min(1).max(MAX_TOKENS_CEILING).optional().openapi({
    description: `Output-token ceiling for this call. Defaults to the deployment's ceiling (usually 4096).`,
    example: 1024,
  }),
});

const generateParamsSchema = z.object({
  studentId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "studentId", in: "path" },
      description: "The student whose AI quota the generation draws on.",
    }),
});

const generateRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/generate",
  tags: ["AI"],
  operationId: "generateAiContent",
  summary: "Generate AI content through the model-routing gateway",
  description:
    "Routes the requested AI feature to a model tier (ask/exam -> large, summary/flashcards -> " +
    "small), calls the provider, and commits the provider-reported token usage against this " +
    "student's AI quota. Consumes the same gate as every other AI surface (403/402/429). " +
    "Refuses with 503 AI_LLM_DISABLED when the LLM plane is turned off, 503 AI_LLM_UNAVAILABLE " +
    "with Retry-After while the provider is failing, and 503 AI_LLM_REQUEST_REJECTED when the " +
    "provider declines the request itself.",
  security: [{ bearerAuth: [] }],
  request: {
    params: generateParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: generateBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The generated text, the serving model and tier, and the token usage.",
        schema: generateResponseSchema,
      },
    },
    [400, 401, 402, 403, 422, 429, 500, 503],
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

export function aiGatewayRoutes(deps: {
  database: Database;
  /**
   * The configured LLM provider, or null when the AI_LLM_ENABLED kill switch is off. Null answers
   * 503 AI_LLM_DISABLED at request time; the route still registers so the published contract does
   * not depend on a deployment's environment (the storage-upload precedent).
   */
  provider: LlmProvider | null;
  /**
   * Environment overrides for the routing table's model ids (`AI_LLM_SMALL_MODEL` /
   * `AI_LLM_LARGE_MODEL`). A partial map leaves the untouched tier on its catalog default.
   */
  modelOverrides?: Partial<Record<AiModelTier, string>>;
}): OpenAPIHono<AppEnv> {
  const { database, provider, modelOverrides = {} } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // The audit-coverage gate (tests/audit-coverage.test.ts) requires every mutating route to declare
  // its audit intent. This POST's one write is the metered student's own usage ledger; the
  // declaration is metadata (auditAction never writes a row) — the storage-upload precedent, which
  // declares against a mutation whose record is the object itself rather than an audit_logs row.
  routes.use("/api/ai/students/:studentId/generate", auditAction("update", "ai_usage_meters"));

  routes.openapi(generateRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const body = c.req.valid("json");
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

    const routed = resolveAiModel(body.feature, modelOverrides);

    try {
      const generation = await provider.generate({
        model: routed.model,
        prompt: body.prompt,
        system: body.system,
        maxTokens: body.maxTokens,
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

      // The gate released the hold if the handler never settled; committing the real cost settles it.
      await quota.commit(generation.usage.totalTokens);

      return c.json(
        {
          content: generation.content,
          model: generation.model,
          tier: routed.tier,
          feature: body.feature,
          usage: generation.usage,
        },
        200,
      );
    } catch (error) {
      throwLlmError(c, error);
    }
  });

  return routes;
}
