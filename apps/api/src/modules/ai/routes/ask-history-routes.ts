import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import { withTenantTx } from "../../../db/tenant-tx";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { requireFeature } from "../../features/middleware";
import { listConversations, loadConversation } from "../ask/history";
import { AI_FEATURE_ROUTE } from "../gate/token-budget";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

/**
 * Ask AI chat history: `GET /api/ai/students/{studentId}/conversations` lists the student's
 * earlier chats, `GET .../conversations/{conversationId}` returns one chat's turns so the client
 * can reopen it and keep asking with the ask route's `conversation_id`.
 *
 * Reads only: no model call, no quota reservation. They sit behind the same `ai_tutor` feature
 * check as the ask route (checked, not metered) but deliberately not behind the token budget, so a
 * student who has spent this month's budget can still read what they already asked. The
 * `aiStudentSelfGate` mounted in app.ts keeps the path's student the caller's own.
 */

const AI_ASK_CONVERSATION_PAGE_DEFAULT = 30;
const AI_ASK_CONVERSATION_PAGE_MAX = 50;

const studentParamSchema = z
  .string()
  .uuid()
  .openapi({
    param: { name: "studentId", in: "path" },
    description: "The student whose Ask AI conversations are read.",
  });

const listQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AI_ASK_CONVERSATION_PAGE_MAX)
    .optional()
    .openapi({
      param: { name: "limit", in: "query" },
      description: `Conversations per page. Defaults to ${AI_ASK_CONVERSATION_PAGE_DEFAULT}, max ${AI_ASK_CONVERSATION_PAGE_MAX}.`,
    }),
  before: z
    .string()
    .datetime()
    .optional()
    .openapi({
      param: { name: "before", in: "query" },
      description:
        "Keyset cursor: the previous page's `next_before`. Returns conversations last active " +
        "before this instant.",
    }),
});

const conversationSummarySchema = z.object({
  id: z.string().uuid(),
  /** The conversation's first question, cut to 200 characters. */
  title: z.string(),
  message_count: z.number().int().positive(),
  created_at: z.string().datetime(),
  last_message_at: z.string().datetime(),
});

const listResponseSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  /** Pass as `before` for the next page; null on the last page. */
  next_before: z.string().datetime().nullable(),
});

const citationSchema = z.object({
  /** The `[order]` the answer text cites this source as. */
  order: z.number().int().min(1),
  chunk_id: z.string().uuid(),
  material_id: z.string().uuid(),
  material_title: z.string().nullable(),
  page_number: z.number().int().nullable(),
  section_title: z.string().nullable(),
});

const conversationMessageSchema = z.object({
  id: z.string().uuid(),
  question: z.string(),
  answer: z.string(),
  created_at: z.string().datetime(),
  citations: z.array(citationSchema),
});

const conversationResponseSchema = z.object({
  id: z.string().uuid(),
  created_at: z.string().datetime(),
  /** Oldest first. */
  messages: z.array(conversationMessageSchema),
});

const listConversationsRoute = createRoute({
  method: "get",
  path: "/api/ai/students/{studentId}/conversations",
  tags: ["AI"],
  operationId: "listAskAiConversations",
  summary: "List the student's Ask AI conversations",
  description:
    "The student's Ask AI chats, most recently active first, each titled by its first question. " +
    "Only conversations with unexpired messages (90-day retention) are listed. Draws no LLM " +
    "tokens and is not quota-metered.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ studentId: studentParamSchema }),
    query: listQuerySchema,
  },
  responses: standardResponses(
    { 200: { description: "One page of conversations.", schema: listResponseSchema } },
    [400, 401, 402, 403, 422, 429, 500],
  ),
});

const getConversationRoute = createRoute({
  method: "get",
  path: "/api/ai/students/{studentId}/conversations/{conversationId}",
  tags: ["AI"],
  operationId: "getAskAiConversation",
  summary: "Get one Ask AI conversation's turns",
  description:
    "The conversation's unexpired question-and-answer turns, oldest first, each with its " +
    "resolved citations. Continue the chat by sending its id as the ask route's " +
    "`conversation_id`. Answers 404 AI_CONVERSATION_NOT_FOUND for a conversation that is not " +
    "this student's. Draws no LLM tokens and is not quota-metered.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      studentId: studentParamSchema,
      conversationId: z
        .string()
        .uuid()
        .openapi({ param: { name: "conversationId", in: "path" } }),
    }),
  },
  responses: standardResponses(
    { 200: { description: "The conversation's turns.", schema: conversationResponseSchema } },
    [400, 401, 402, 403, 404, 422, 429, 500],
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

export function aiAskHistoryRoutes(deps: { database: Database }): OpenAPIHono<AppEnv> {
  const { database } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  routes.use(
    "/api/ai/students/:studentId/conversations",
    requireFeature("ai_tutor", AI_FEATURE_ROUTE),
  );
  routes.use(
    "/api/ai/students/:studentId/conversations/:conversationId",
    requireFeature("ai_tutor", AI_FEATURE_ROUTE),
  );

  routes.openapi(listConversationsRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const query = c.req.valid("query");
    const limit = query.limit ?? AI_ASK_CONVERSATION_PAGE_DEFAULT;

    const page = await withTenantTx(database, tenantFrom(c), (tx) =>
      listConversations(tx, {
        studentId,
        limit,
        before: query.before ? new Date(query.before) : null,
      }),
    );

    const last = page.conversations.at(-1);
    return c.json(
      {
        conversations: page.conversations.map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          message_count: conversation.messageCount,
          created_at: conversation.createdAt.toISOString(),
          last_message_at: conversation.lastMessageAt.toISOString(),
        })),
        next_before: page.hasMore && last ? last.lastMessageAt.toISOString() : null,
      },
      200,
    );
  });

  routes.openapi(getConversationRoute, async (c) => {
    const { studentId, conversationId } = c.req.valid("param");
    const locale = (c.get("locale") ?? "en") as SupportedLocale;

    const conversation = await withTenantTx(database, tenantFrom(c), (tx) =>
      loadConversation(tx, { studentId, conversationId, locale }),
    );

    return c.json(
      {
        id: conversation.id,
        created_at: conversation.createdAt.toISOString(),
        messages: conversation.messages.map((message) => ({
          id: message.id,
          question: message.question,
          answer: message.answer,
          created_at: message.createdAt.toISOString(),
          citations: message.citations.map((citation) => ({
            order: citation.order,
            chunk_id: citation.chunkId,
            material_id: citation.materialId,
            material_title: citation.materialTitle,
            page_number: citation.pageNumber,
            section_title: citation.sectionTitle,
          })),
        })),
      },
      200,
    );
  });

  return routes;
}
