import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import { resolveCitations, type Citation } from "../ask/citations";
import { persistAskMessage, resolveConversation } from "../ask/persistence";
import { assembleGroundedPrompt, toGroundedSources } from "../ask/prompt";
import { assessGrounding, type NearestTopic } from "../ask/refusal";
import { AI_ASK_QUESTION_MAX_CHARS, AI_ASK_SOURCE_LIMIT, AI_EXPLAIN_LEVELS } from "../config";
import { getAiQuota } from "../gate/entitlement-gate";
import { LlmProviderError } from "../llm/provider";
import { AI_MODEL_TIERS, resolveAiModel } from "../llm/routing";
import { moderateInput, moderateOutput, textHash, type AgeLevel } from "../moderation/moderate";
import { persistModerationDecision } from "../moderation/persistence";
import { hybridSearch } from "../retrieval/search";
import { recordDurableUsage } from "../usage/durable";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { LlmProvider, LlmUsage } from "../llm/provider";
import type { AiModelTier } from "../llm/routing";
import type { QueryEmbedder } from "../retrieval/embeddings";
import type { Context } from "hono";

/**
 * Ask AI streaming endpoint (ST-165): `POST /api/ai/students/{studentId}/ask`.
 *
 * The chat surface of the RAG pair. The route retrieves the school's corpus for the student's
 * question (the same hybrid search the search endpoint exposes), hardens the retrieved chunks into
 * a grounded prompt (`ask/prompt.ts` — injection defenses documented there and in
 * `docs/rag/ask-ai-streaming-and-prompt-injection.md`), streams the large-tier model's tokens back
 * as Server-Sent Events, validates the model's `[N]` citations against the retrieved chunks, and
 * persists the turn (conversation + message + citations) in one tenant transaction.
 *
 * ## SSE contract
 *
 * The response is `text/event-stream` with a fixed event sequence on the answer path:
 *
 *   1. `sources` — the numbered, citable sources the model was grounded on, carrying the
 *      machine-readable citation anchors (chunk id, material, page, section) and the
 *      `conversation_id` the client keeps appending to.
 *   2. `delta` — one event per token chunk, `{ "delta": "..." }`.
 *   3. `done` — the complete answer with `text`, provider-reported `usage`, the resolved
 *      citations, the serving model/tier, and the persisted `message_id`.
 *
 * Two terminal events replace that sequence instead of erroring with an HTTP status, because the
 * stream has already started:
 *
 *   - `refusal` — retrieval fell below the grounding bar (`ask/refusal.ts`); carries the
 *     `AI_ASK_INSUFFICIENT_GROUNDING` code and the nearest-topics payload.
 *   - `error` — a provider or network failure mid-stream; carries `AI_LLM_UNAVAILABLE` or
 *     `AI_LLM_REQUEST_REJECTED`. Nothing is persisted for a turn that never completed.
 *
 * Everything that can still fail *before* the stream opens — validation, the provider kill switch,
 * retrieval, conversation resolution — is done in the handler and throws a normal problem+json
 * response, so the client only ever sees a 200 stream once the answer path is genuinely underway.
 *
 * ## Reservation lifecycle
 *
 * `streamSSE` fires its callback without awaiting it and returns the Response immediately, so the
 * handler resolves before the stream has written a byte. The ST-155 gate's `finally` would release
 * the reservation right then — before anything was produced to commit — so the route calls
 * `quota.detach()` at the top of the stream callback (once success up to that point is certain)
 * and owns the settle from there: `commit(actual)` after a completed turn, `release()` on refusal
 * or a mid-stream failure. The gate's auto-release and the stream's settle can never race, because
 * `detach()` marks the handle settled from the gate's point of view.
 *
 * Cost flow mirrors the generate route: retrieval and conversation work happen in a short tenant
 * transaction, the provider call runs outside any transaction, and the provider-reported tokens
 * are recorded durably (`app.ai_usage_meters`) and committed to quota in a second short tenant
 * transaction once the turn completes.
 */

const citationSchema = z.object({
  /** The source's 1-based position, as the model cited it (`[order]`). */
  order: z.number().int().min(1),
  /** `app.material_chunks.id` — the citation always resolves to a chunk that was retrieved. */
  chunk_id: z.string().uuid(),
  material_id: z.string().uuid(),
  material_title: z.string().nullable(),
  page_number: z.number().int().nullable(),
  section_title: z.string().nullable(),
});

const nearestTopicSchema = z.object({
  chunk_id: z.string().uuid(),
  material_title: z.string().nullable(),
  section_title: z.string().nullable(),
});

const askSourcesEventSchema = z.object({
  conversation_id: z.string().uuid(),
  model: z.string(),
  tier: z.enum(AI_MODEL_TIERS),
  sources: z.array(citationSchema),
});

const askDeltaEventSchema = z.object({
  delta: z.string(),
});

const askUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});

const askDoneEventSchema = z.object({
  message_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  model: z.string(),
  tier: z.enum(AI_MODEL_TIERS),
  text: z.string(),
  stop_reason: z.string().nullable(),
  usage: askUsageSchema,
  citations: z.array(citationSchema),
});

const askRefusalEventSchema = z.object({
  code: z.string(),
  message: z.string(),
  topics: z.array(nearestTopicSchema),
});

const askErrorEventSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const askModerationBlockedEventSchema = z.object({
  code: z.string(),
  category: z.string(),
  guidance: z.string(),
  phase: z.enum(["input", "output"]),
});

const askBodySchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(AI_ASK_QUESTION_MAX_CHARS)
    .openapi({
      description: `The student's question. Up to ${AI_ASK_QUESTION_MAX_CHARS} characters.`,
      example: "How does photosynthesis convert light energy?",
    }),
  conversation_id: z
    .string()
    .uuid()
    .optional()
    .openapi({
      description:
        "Continue an existing conversation. When omitted, a new conversation is created and its " +
        "id is returned in the sources and done events.",
      example: "0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12",
    }),
  level: z
    .enum(AI_EXPLAIN_LEVELS)
    .optional()
    .default("high")
    .openapi({
      description:
        "The student's age-appropriate level for content moderation. Determines how strict the " +
        "content filter is: 'elementary' is strictest, 'high' is most permissive. Defaults to 'high'.",
      example: "middle",
    }),
});

const askParamsSchema = z.object({
  studentId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "studentId", in: "path" },
      description: "The student whose AI quota the answer draws on.",
    }),
});

const askRoute = createRoute({
  method: "post",
  path: "/api/ai/students/{studentId}/ask",
  tags: ["AI"],
  operationId: "askAiStreaming",
  summary: "Stream a grounded answer with citations",
  description:
    "The Ask AI chat surface. Retrieves the school's corpus for the question, streams the " +
    "routed large-tier model's answer as Server-Sent Events, and persists the turn with its " +
    "citations. The stream's events are: `sources` (the numbered, citable chunks and the " +
    "conversation id), one `delta` per token chunk, and `done` (the complete answer, usage, and " +
    "machine-readable citations). When retrieval cannot ground the question, the stream carries a " +
    "single `refusal` event with the nearest topics instead of an answer. The question and the " +
    "sources are treated strictly as data, never as instructions (see the prompting spec); the " +
    "conversation and message are persisted with a 90-day retention, and the tokens are recorded " +
    "durably and committed against this student's AI quota. Answers 503 AI_LLM_DISABLED when the " +
    "LLM plane is off, 404 AI_CONVERSATION_NOT_FOUND for a foreign conversation, and the gate's " +
    "403/402/429 when the student is not entitled.",
  security: [{ bearerAuth: [] }],
  request: {
    params: askParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: askBodySchema } },
    },
  },
  responses: {
    200: {
      description:
        "An SSE stream. Answer path: `sources`, then one `delta` per token chunk, then `done`. " +
        "Refusal path: a single `refusal` event carrying the nearest topics. Failure path " +
        "(mid-stream only): a single `error` event. Problems before the stream opens are normal " +
        "problem+json responses.",
      headers: requestIdHeaders,
      content: {
        "text/event-stream": {
          schema: z.discriminatedUnion("event", [
            z.object({ event: z.literal("sources"), data: askSourcesEventSchema }),
            z.object({ event: z.literal("delta"), data: askDeltaEventSchema }),
            z.object({ event: z.literal("done"), data: askDoneEventSchema }),
            z.object({ event: z.literal("refusal"), data: askRefusalEventSchema }),
            z.object({
              event: z.literal("moderation_blocked"),
              data: askModerationBlockedEventSchema,
            }),
            z.object({ event: z.literal("error"), data: askErrorEventSchema }),
          ]),
        },
      },
    },
    ...standardResponses({} as const, [400, 401, 402, 403, 404, 422, 429, 500, 503]),
  },
});

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/** The machine-readable citation anchor one grounded source (or resolved citation) renders into. */
function citationAnchor(source: {
  order: number;
  chunkId: string;
  materialId: string;
  materialTitle: string | null;
  pageNumber: number | null;
  sectionTitle: string | null;
}) {
  return {
    order: source.order,
    chunk_id: source.chunkId,
    material_id: source.materialId,
    material_title: source.materialTitle,
    page_number: source.pageNumber,
    section_title: source.sectionTitle,
  };
}

function nearestTopicAnchor(topic: NearestTopic) {
  return {
    chunk_id: topic.chunkId,
    material_title: topic.materialTitle,
    section_title: topic.sectionTitle,
  };
}

function usageAnchor(usage: LlmUsage) {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}

/**
 * Map a provider failure onto the same taxonomy the generate route's problem+json uses, but as an
 * SSE `error` event: a non-transient 4xx is a verdict from a healthy provider
 * (`AI_LLM_REQUEST_REJECTED`), everything else is transient (`AI_LLM_UNAVAILABLE`). Non-provider
 * errors are treated as transient too, so an internal bug surfaces to the client as an honest
 * "unavailable" rather than a silent stream cut.
 */
function streamError(c: Context<AppEnv>, error: unknown): { code: string; message: string } {
  const locale = (c.get("locale") ?? "en") as SupportedLocale;
  if (
    error instanceof LlmProviderError &&
    error.kind === "http" &&
    error.status < 500 &&
    error.status !== 429
  ) {
    return {
      code: ERROR_CODES.AI_LLM_REQUEST_REJECTED,
      message: getLocalizedMessage(ERROR_CODES.AI_LLM_REQUEST_REJECTED, locale),
    };
  }
  return {
    code: ERROR_CODES.AI_LLM_UNAVAILABLE,
    message: getLocalizedMessage(ERROR_CODES.AI_LLM_UNAVAILABLE, locale),
  };
}

export function aiAskRoutes(deps: {
  database: Database;
  /**
   * The configured LLM provider, or null when the AI_LLM_ENABLED kill switch is off. Null answers
   * 503 AI_LLM_DISABLED (a normal problem+json, before any stream opens); the route still
   * registers so the published contract does not depend on a deployment's environment.
   */
  provider: LlmProvider | null;
  /** The query embedder for the retrieval leg, the same one the search endpoint uses. */
  embedder: QueryEmbedder;
  /** Environment overrides for the routing table's model ids (`AI_LLM_LARGE_MODEL`). */
  modelOverrides?: Partial<Record<AiModelTier, string>>;
}): OpenAPIHono<AppEnv> {
  const { database, provider, embedder, modelOverrides = {} } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // The audit-coverage gate (tests/audit-coverage.test.ts) requires every mutating route to
  // declare its audit intent. This POST's writes are the conversation/message/citation rows; the
  // declaration is metadata (auditAction never writes a row) — the storage-upload precedent, where
  // the mutation's own record is the audit record rather than a parallel audit_logs row.
  routes.use("/api/ai/students/{studentId}/ask", auditAction("insert", "ai_messages"));

  routes.openapi(askRoute, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const quota = getAiQuota(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;

    if (!provider) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.AI_LLM_DISABLED,
        getLocalizedMessage(ERROR_CODES.AI_LLM_DISABLED, locale),
      );
    }

    const routed = resolveAiModel("ask", modelOverrides);

    // Input moderation: check the student's question against the age-appropriate content policy
    // before any expensive work (retrieval, conversation resolution). Blocks with a problem+json
    // response — no LLM call, no message persisted.
    const inputModeration = moderateInput(body.question, body.level as AgeLevel);
    if (inputModeration.blocked) {
      await withTenantTx(database, tenantFrom(c), async (tx) => {
        await persistModerationDecision(tx, {
          schoolId: auth.schoolId,
          studentId,
          messageId: null,
          phase: "input",
          textHash: textHash(body.question),
          blocked: true,
          category: inputModeration.category ?? null,
        });
      });
      throw new CodedHttpException(
        400,
        ERROR_CODES.AI_MODERATION_INPUT_BLOCKED,
        inputModeration.guidance ??
          getLocalizedMessage(ERROR_CODES.AI_MODERATION_INPUT_BLOCKED, locale),
      );
    }

    // Pre-flight: every remaining thing that can fail before the stream opens — retrieval and
    // conversation resolution — runs here, so its failures are ordinary problem+json responses.
    // It is one short tenant transaction; the provider call (tens of seconds) never holds a
    // database connection.
    const preflight = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const search = await hybridSearch(tx, {
        query: body.question,
        queryVector: embedder.embed(body.question),
        limit: AI_ASK_SOURCE_LIMIT,
      });
      const conversationId = await resolveConversation(tx, {
        schoolId: auth.schoolId,
        studentId,
        conversationId: body.conversation_id ?? null,
        model: routed.model,
        locale,
      });
      return { search, conversationId };
    });

    const sources = toGroundedSources(preflight.search.hits);
    const grounding = assessGrounding(preflight.search.hits);
    const prompt = assembleGroundedPrompt(body.question, sources);

    return streamSSE(
      c,
      async (stream) => {
        // Success up to the opening of the stream is certain: retrieval, conversation, and the
        // grounded prompt are all done. Hand the live reservation off so the gate's finally (which
        // runs when this handler returns) cannot release it before the stream produces anything.
        quota.detach();

        if (!grounding.grounded) {
          await stream.writeSSE({
            event: "refusal",
            data: JSON.stringify({
              code: ERROR_CODES.AI_ASK_INSUFFICIENT_GROUNDING,
              message: getLocalizedMessage(ERROR_CODES.AI_ASK_INSUFFICIENT_GROUNDING, locale),
              topics: grounding.topics.map(nearestTopicAnchor),
            }),
          });
          await quota.release();
          return;
        }

        await stream.writeSSE({
          event: "sources",
          data: JSON.stringify({
            conversation_id: preflight.conversationId,
            model: routed.model,
            tier: routed.tier,
            sources: sources.map(citationAnchor),
          }),
        });

        let committed = false;
        try {
          let text = "";
          let usage: LlmUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
          let stopReason: string | null = null;

          for await (const event of provider.stream({
            model: routed.model,
            prompt: prompt.user,
            system: prompt.system,
            userId: auth.userId,
            circuitKey: auth.schoolId,
          })) {
            if (event.type === "delta") {
              text = event.text;
              await stream.writeSSE({
                event: "delta",
                data: JSON.stringify({ delta: event.delta }),
              });
            } else {
              // A done event ends the stream, including a truncated one: it carries what arrived.
              text = event.text;
              usage = event.usage;
              stopReason = event.stopReason;
            }
          }

          const citations: Citation[] = resolveCitations(text, sources);

          // Output moderation: check the model's generation against the age-appropriate content
          // policy. If blocked, the message is not persisted, the quota is released, and a
          // moderation_blocked event is sent. The student may have seen partial deltas — the client
          // should clear any rendered content upon receiving this event.
          const outputModeration = moderateOutput(text, body.level as AgeLevel);
          if (outputModeration.blocked) {
            await withTenantTx(database, tenantFrom(c), async (tx) => {
              await persistModerationDecision(tx, {
                schoolId: auth.schoolId,
                studentId,
                messageId: null,
                phase: "output",
                textHash: textHash(text),
                blocked: true,
                category: outputModeration.category ?? null,
              });
            });
            await stream.writeSSE({
              event: "moderation_blocked",
              data: JSON.stringify({
                code: ERROR_CODES.AI_MODERATION_OUTPUT_BLOCKED,
                category: outputModeration.category ?? "unknown",
                guidance:
                  outputModeration.guidance ??
                  getLocalizedMessage(ERROR_CODES.AI_MODERATION_OUTPUT_BLOCKED, locale),
                phase: "output",
              }),
            });
            await quota.release();
            return;
          }

          const messageId = await withTenantTx(database, tenantFrom(c), async (tx) => {
            await recordDurableUsage(tx, auth.schoolId, studentId, usage.totalTokens);
            return persistAskMessage(tx, {
              schoolId: auth.schoolId,
              conversationId: preflight.conversationId,
              question: body.question,
              answer: text,
              citations,
              promptTokens: usage.inputTokens,
              completionTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
            });
          });

          await quota.commit(usage.totalTokens);
          committed = true;

          await stream.writeSSE({
            event: "done",
            data: JSON.stringify({
              message_id: messageId,
              conversation_id: preflight.conversationId,
              model: routed.model,
              tier: routed.tier,
              text,
              stop_reason: stopReason,
              usage: usageAnchor(usage),
              citations: citations.map(citationAnchor),
            }),
          });
        } catch (error) {
          const log = c.get("log");
          log?.error(
            {
              err: error,
              school_id: auth.schoolId,
              student_id: studentId,
              conversation_id: preflight.conversationId,
            },
            "ask stream failed; no message persisted",
          );
          if (!committed) {
            await quota.release().catch((err: unknown) => {
              log?.warn(
                { err, school_id: auth.schoolId, student_id: studentId },
                "ai quota release failed",
              );
            });
          }
          const mapped = streamError(c, error);
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify(mapped),
          });
        }
      },
      // Backstop for a throw the try/catch did not catch (or a write failure after a disconnect):
      // surface it as an SSE error and settle the hold, never letting a detached reservation leak.
      async (error, stream) => {
        const log = c.get("log");
        log?.error(
          { err: error, school_id: auth.schoolId, student_id: studentId },
          "ask stream callback threw",
        );
        try {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify(streamError(c, error)),
          });
        } catch {
          // The client is gone; the stream is already closed.
        }
        await quota.release().catch((err: unknown) => {
          log?.warn(
            { err, school_id: auth.schoolId, student_id: studentId },
            "ai quota release failed",
          );
        });
      },
    );
  });

  return routes;
}
