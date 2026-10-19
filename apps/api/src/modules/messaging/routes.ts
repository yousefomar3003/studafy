import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS, ROLES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { withTenantTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { onlyMethods } from "../../middleware/only-methods";
import { rateLimiterMiddleware } from "../../middleware/rateLimiter";
import { openApiValidationHook } from "../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";

import {
  createMessageReportBodySchema,
  createMessageReportResponseSchema,
  messageReportDetailEnvelopeSchema,
  messageReportEnvelopeSchema,
  messageReportIdParamSchema,
  messageReportListQuerySchema,
  messageReportListSchema,
  updateMessageReportBodySchema,
} from "./report-schemas";
import {
  createMessageReport,
  getMessageReport,
  listMessageReports,
  updateMessageReport,
} from "./reports";
import {
  blockStateSchema,
  contactListSchema,
  contactsQuerySchema,
  conversationEnvelopeSchema,
  conversationIdParamSchema,
  conversationListQuerySchema,
  conversationListSchema,
  createConversationBodySchema,
  createTeacherConversationBodySchema,
  messageEnvelopeSchema,
  messageListQuerySchema,
  messageListSchema,
  participantProfileEnvelopeSchema,
  sendMessageBodySchema,
  teacherContactListSchema,
} from "./schemas";
import {
  blockConversationParticipant,
  getConversation,
  getParticipantProfile,
  getOrCreateConversation,
  getOrCreateTeacherConversation,
  listContacts,
  listTeacherContacts,
  listConversations,
  listMessages,
  markConversationRead,
  sendMessage,
  unblockConversationParticipant,
} from "./service";

import type { MessagingActor } from "./service";
import type { Database } from "../../db/client";
import type { StorageService } from "../../lib/storage";
import type { AppEnv } from "../../middleware/requestId";
import type { RedisClient } from "../../redis";
import type { Context } from "hono";

const TAG = "Messaging";

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function actorFrom(c: Context<AppEnv>): MessagingActor {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId };
}

/** /contacts and POST /conversations are the parent's side of opening a thread. */
function requireParent(c: Context<AppEnv>): void {
  if (!requireAuth(c).roles.includes(ROLES.PARENT)) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "Only a parent can start a conversation",
    );
  }
}

/** The teaching roles that carry message:read — the teacher's side of opening a thread. */
const TEACHING_ROLES: readonly string[] = [ROLES.INSTRUCTOR];

/** /teacher-contacts and POST /teacher-conversations are the teacher's side of opening a thread. */
function requireTeacher(c: Context<AppEnv>): void {
  if (!requireAuth(c).roles.some((role) => TEACHING_ROLES.includes(role))) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "Only a teacher can start a conversation with a parent",
    );
  }
}

const contactsRoute = createRoute({
  method: "get",
  path: "/api/messaging/contacts",
  tags: [TAG],
  operationId: "listMessagingContacts",
  summary: "List the teachers a parent can message about a child",
  description:
    "Teachers (by user id) who teach a class the linked child is currently enrolled in, each with " +
    "those classes and the existing conversation id, if any. Parents only; 404 when the child is " +
    "not linked to the caller.",
  security: [{ bearerAuth: [] }],
  request: { query: contactsQuerySchema },
  responses: standardResponses(
    { 200: { description: "Messageable teachers.", schema: contactListSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const listConversationsRoute = createRoute({
  method: "get",
  path: "/api/messaging/conversations",
  tags: [TAG],
  operationId: "listConversations",
  summary: "List the caller's conversations",
  description:
    "The caller's own parent<->teacher conversations, newest activity first, each with its last " +
    "message and the caller's unread count.",
  security: [{ bearerAuth: [] }],
  request: { query: conversationListQuerySchema },
  responses: standardResponses(
    { 200: { description: "The caller's conversations.", schema: conversationListSchema } },
    [400, 401, 403, 500],
  ),
});

const createConversationRoute = createRoute({
  method: "post",
  path: "/api/messaging/conversations",
  tags: [TAG],
  operationId: "createConversation",
  summary: "Open (or reopen) a conversation with a child's teacher",
  description:
    "Get-or-create: answers 201 with a new conversation, or 200 with the one that already exists " +
    "for this parent, teacher and child. Parents only; 404 when the child is not linked to the " +
    "caller, 403 when the teacher does not teach the child, 403 MESSAGING_BLOCKED when a block " +
    "stands between the parent and the teacher (either direction).",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createConversationBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: { description: "The existing conversation.", schema: conversationEnvelopeSchema },
      201: { description: "The newly opened conversation.", schema: conversationEnvelopeSchema },
    },
    [400, 401, 403, 404, 500],
  ),
});

const teacherContactsRoute = createRoute({
  method: "get",
  path: "/api/messaging/teacher-contacts",
  tags: [TAG],
  operationId: "listTeacherMessagingContacts",
  summary: "List the parents a teacher can message",
  description:
    "Students currently enrolled in a class the caller teaches (lead teacher, or a slot in an " +
    "approved timetable) who have a linked parent, each with those classes and the parents the " +
    "caller can message about them, plus any existing conversation id. Teachers " +
    "(INSTRUCTOR) only.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Messageable parents, by student.", schema: teacherContactListSchema } },
    [401, 403, 500],
  ),
});

const createTeacherConversationRoute = createRoute({
  method: "post",
  path: "/api/messaging/teacher-conversations",
  tags: [TAG],
  operationId: "createTeacherConversation",
  summary: "Open (or reopen) a conversation with a student's parent",
  description:
    "Get-or-create: answers 201 with a new conversation, or 200 with the one that already exists " +
    "for this parent, teacher and student — including one the parent started. Teachers " +
    "(INSTRUCTOR) only; 403 unless the caller teaches the student and the " +
    "parent is linked to them; 403 MESSAGING_BLOCKED when a block stands between the two " +
    "(either direction).",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createTeacherConversationBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: { description: "The existing conversation.", schema: conversationEnvelopeSchema },
      201: { description: "The newly opened conversation.", schema: conversationEnvelopeSchema },
    },
    [400, 401, 403, 500],
  ),
});

const getConversationRoute = createRoute({
  method: "get",
  path: "/api/messaging/conversations/{conversationId}",
  tags: [TAG],
  operationId: "getConversation",
  summary: "Get one of the caller's conversations",
  security: [{ bearerAuth: [] }],
  request: { params: conversationIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The conversation.", schema: conversationEnvelopeSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const listMessagesRoute = createRoute({
  method: "get",
  path: "/api/messaging/conversations/{conversationId}/messages",
  tags: [TAG],
  operationId: "listMessages",
  summary: "Page or poll a conversation's messages",
  description:
    "Messages oldest first. By default the latest `limit`; `before` pages older history; `since` " +
    "returns messages strictly newer than a timestamp (for polling). 404 for a non-participant.",
  security: [{ bearerAuth: [] }],
  request: { params: conversationIdParamSchema, query: messageListQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of messages.", schema: messageListSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const sendMessageRoute = createRoute({
  method: "post",
  path: "/api/messaging/conversations/{conversationId}/messages",
  tags: [TAG],
  operationId: "sendMessage",
  summary: "Send a message",
  description:
    "Appends a message — text (0-2000 characters after trimming), up to 4 images, or both; at " +
    "least one is required — and notifies the other participant in-app (an image-only message " +
    'previews as "📷 Photo"). Images are staged first via POST /api/storage/uploads/request-upload ' +
    "with content_class `message.attachment` (image/jpeg, image/png, image/webp, image/heic; " +
    "10 MiB each) and PUT to the returned URL; this call then re-checks each stored object's type " +
    "and size, promotes it, and records it in the same transaction as the message. 400 for a bad " +
    "body or an image that fails the checks, 402 STORAGE_QUOTA_EXCEEDED, 403 MESSAGING_BLOCKED " +
    "when a block stands between the participants (either direction), 403 STORAGE_KEY_FORBIDDEN " +
    "for a key outside the caller's school, 404 for a non-participant or STORAGE_OBJECT_NOT_FOUND " +
    "for a key that was never uploaded, 503 STORAGE_NOT_CONFIGURED for images without object " +
    "storage. Rate-limited per user.",
  security: [{ bearerAuth: [] }],
  request: {
    params: conversationIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: sendMessageBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The sent message.", schema: messageEnvelopeSchema } },
    [400, 401, 402, 403, 404, 429, 500, 503],
  ),
});

const markReadRoute = createRoute({
  method: "post",
  path: "/api/messaging/conversations/{conversationId}/read",
  tags: [TAG],
  operationId: "markConversationRead",
  summary: "Mark a conversation read",
  description: "Moves the caller's read marker to now. 404 for a non-participant.",
  security: [{ bearerAuth: [] }],
  request: { params: conversationIdParamSchema },
  responses: {
    204: { description: "Marked read.", headers: requestIdHeaders },
    ...standardResponses({}, [400, 401, 403, 404, 500]),
  },
});

const profileRoute = createRoute({
  method: "get",
  path: "/api/messaging/conversations/{conversationId}/profile",
  tags: [TAG],
  operationId: "getConversationParticipantProfile",
  summary: "Get the other participant's profile",
  description:
    "What the caller may know about the person on the other side of the thread. role=teacher " +
    "(caller is the parent): the teacher's classes the thread's child is enrolled in, and the " +
    "subjects the teacher teaches. role=parent (caller is the teacher): the parent's relationship " +
    "to the thread's child and those of the parent's children the caller teaches, with the " +
    "classes. Both carry the block state. Never contact details. 404 for a non-participant.",
  security: [{ bearerAuth: [] }],
  request: { params: conversationIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The other participant.", schema: participantProfileEnvelopeSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const blockRoute = createRoute({
  method: "post",
  path: "/api/messaging/conversations/{conversationId}/block",
  tags: [TAG],
  operationId: "blockConversationParticipant",
  summary: "Block the other participant",
  description:
    "Idempotent: 201 when the block is new, 200 when the caller had already blocked them. While a " +
    "block stands in either direction neither user can send the other a message or open a new " +
    "thread with them (403 MESSAGING_BLOCKED); history stays readable. 404 for a non-participant.",
  security: [{ bearerAuth: [] }],
  request: { params: conversationIdParamSchema },
  responses: standardResponses(
    {
      200: { description: "Already blocked.", schema: blockStateSchema },
      201: { description: "Blocked.", schema: blockStateSchema },
    },
    [400, 401, 403, 404, 500],
  ),
});

const unblockRoute = createRoute({
  method: "delete",
  path: "/api/messaging/conversations/{conversationId}/block",
  tags: [TAG],
  operationId: "unblockConversationParticipant",
  summary: "Unblock the other participant",
  description:
    "Removes the caller's own block, if any (idempotent). A block the other participant placed " +
    "is theirs to lift. 404 for a non-participant.",
  security: [{ bearerAuth: [] }],
  request: { params: conversationIdParamSchema },
  responses: {
    204: { description: "Not blocked by the caller.", headers: requestIdHeaders },
    ...standardResponses({}, [400, 401, 403, 404, 500]),
  },
});

const createReportRoute = createRoute({
  method: "post",
  path: "/api/messaging/conversations/{conversationId}/reports",
  tags: [TAG],
  operationId: "createMessageReport",
  summary: "Report a message or the other participant",
  description:
    "Files a report for the school's reviewers (principal / admin) and snapshots the evidence — " +
    "the reported message and up to 20 before it, or the last 20 for a general report. " +
    "`also_block` blocks the other participant in the same call. 404 for a non-participant or a " +
    "message outside this thread; 409 MESSAGE_REPORT_ALREADY_OPEN when the caller already has an " +
    "open report on the same message (or the same thread, for a general report).",
  security: [{ bearerAuth: [] }],
  request: {
    params: conversationIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createMessageReportBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "Report filed.", schema: createMessageReportResponseSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const listReportsRoute = createRoute({
  method: "get",
  path: "/api/messaging/reports",
  tags: [TAG],
  operationId: "listMessageReports",
  summary: "List the school's messaging reports (review queue)",
  description:
    "Reviewers (messageReport:review: ORG_ADMIN, PRINCIPAL) only. Open reports first, then " +
    "urgent / high / normal, then soonest respond_by.",
  security: [{ bearerAuth: [] }],
  request: { query: messageReportListQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of the queue.", schema: messageReportListSchema } },
    [400, 401, 403, 500],
  ),
});

const getReportRoute = createRoute({
  method: "get",
  path: "/api/messaging/reports/{reportId}",
  tags: [TAG],
  operationId: "getMessageReport",
  summary: "Get a messaging report with its evidence",
  description:
    "Reviewers only. The report plus the evidence snapshot taken when it was filed, with 5-minute " +
    "pre-signed URLs for any images. 404 MESSAGE_REPORT_NOT_FOUND.",
  security: [{ bearerAuth: [] }],
  request: { params: messageReportIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The report.", schema: messageReportDetailEnvelopeSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const updateReportRoute = createRoute({
  method: "patch",
  path: "/api/messaging/reports/{reportId}",
  tags: [TAG],
  operationId: "updateMessageReport",
  summary: "Move a messaging report along the review workflow",
  description:
    "Reviewers only. pending -> in_review | actioned | dismissed; in_review -> actioned | " +
    "dismissed. A resolution note is required to close (actioned / dismissed). 404 " +
    "MESSAGE_REPORT_NOT_FOUND; 409 MESSAGE_REPORT_INVALID_TRANSITION (including a concurrent " +
    "change by another reviewer).",
  security: [{ bearerAuth: [] }],
  request: {
    params: messageReportIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateMessageReportBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated report.", schema: messageReportEnvelopeSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

/**
 * Parent<->teacher 1-to-1 messaging (migration 000127). Reading takes `message:read`, writing
 * `message:send` — both held by PARENT and INSTRUCTOR. Those permissions are
 * the floor; the database scopes every thread to its two participants, and either participant may
 * open one — a parent about a linked child with a teacher who teaches that child, or (000130) a
 * teacher with a linked parent of a child they teach — checked here first, to answer 403 instead
 * of a policy violation. Available to people, not machines: web and mobile sessions
 * only. Sends carry their own per-user rate limit on top of the global one.
 */
export function messagingRoutes(
  database: Database,
  redis: RedisClient | null = null,
  storage: StorageService | null = null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const channelGuard = requireChannel(AUTH_CHANNELS.WEB, AUTH_CHANNELS.MOBILE);
  routes.use("/api/messaging/*", channelGuard);

  routes.use("/api/messaging/contacts", requirePermission(PERMISSIONS.MESSAGE_READ));
  routes.use("/api/messaging/teacher-contacts", requirePermission(PERMISSIONS.MESSAGE_READ));
  routes.use(
    "/api/messaging/teacher-conversations",
    onlyMethods(["POST"], requirePermission(PERMISSIONS.MESSAGE_SEND)),
  );
  routes.use(
    "/api/messaging/conversations",
    onlyMethods(["GET"], requirePermission(PERMISSIONS.MESSAGE_READ)),
  );
  routes.use(
    "/api/messaging/conversations",
    onlyMethods(["POST"], requirePermission(PERMISSIONS.MESSAGE_SEND)),
  );
  routes.use(
    "/api/messaging/conversations/:conversationId",
    requirePermission(PERMISSIONS.MESSAGE_READ),
  );
  routes.use(
    "/api/messaging/conversations/:conversationId/messages",
    onlyMethods(["GET"], requirePermission(PERMISSIONS.MESSAGE_READ)),
  );
  routes.use(
    "/api/messaging/conversations/:conversationId/messages",
    onlyMethods(["POST"], requirePermission(PERMISSIONS.MESSAGE_SEND)),
  );
  routes.use(
    "/api/messaging/conversations/:conversationId/read",
    requirePermission(PERMISSIONS.MESSAGE_READ),
  );
  routes.use(
    "/api/messaging/conversations/:conversationId/profile",
    requirePermission(PERMISSIONS.MESSAGE_READ),
  );
  // Blocking and reporting are safety actions, so they take message:read, not message:send: anyone
  // who can read a thread must be able to stop it or report it, whatever their sending rights.
  routes.use(
    "/api/messaging/conversations/:conversationId/block",
    requirePermission(PERMISSIONS.MESSAGE_READ),
  );
  routes.use(
    "/api/messaging/conversations/:conversationId/reports",
    requirePermission(PERMISSIONS.MESSAGE_READ),
  );
  routes.use("/api/messaging/reports", requirePermission(PERMISSIONS.MESSAGE_REPORT_REVIEW));
  routes.use(
    "/api/messaging/reports/:reportId",
    requirePermission(PERMISSIONS.MESSAGE_REPORT_REVIEW),
  );

  routes.use(
    "/api/messaging/conversations/:conversationId/messages",
    onlyMethods(["POST"], rateLimiterMiddleware({ redis, routeClass: "messaging" })),
  );

  routes.use(
    "/api/messaging/conversations",
    onlyMethods(["POST"], auditAction("insert", "message_conversations")),
  );
  routes.use(
    "/api/messaging/teacher-conversations",
    onlyMethods(["POST"], auditAction("insert", "message_conversations")),
  );
  routes.use(
    "/api/messaging/conversations/:conversationId/messages",
    onlyMethods(["POST"], auditAction("insert", "messages")),
  );
  routes.use(
    "/api/messaging/conversations/:conversationId/block",
    onlyMethods(["POST"], auditAction("insert", "message_blocks")),
  );
  routes.use(
    "/api/messaging/conversations/:conversationId/block",
    onlyMethods(["DELETE"], auditAction("delete", "message_blocks")),
  );
  routes.use(
    "/api/messaging/conversations/:conversationId/reports",
    onlyMethods(["POST"], auditAction("insert", "message_reports")),
  );
  routes.use(
    "/api/messaging/reports/:reportId",
    onlyMethods(["PATCH"], auditAction("update", "message_reports")),
  );
  // Declaration only: a read marker is the caller's own state, moved on every open of a thread, so
  // it writes no app.audit_logs row (the same as the AI usage-meter routes' declarations).
  routes.use(
    "/api/messaging/conversations/:conversationId/read",
    onlyMethods(["POST"], auditAction("update", "message_conversations")),
  );

  routes.openapi(contactsRoute, async (c) => {
    requireParent(c);
    const { student_id } = c.req.valid("query");
    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      listContacts(tx, actorFrom(c), student_id),
    );
    return c.json(result, 200);
  });

  routes.openapi(listConversationsRoute, async (c) => {
    const { student_id } = c.req.valid("query");
    const conversations = await withTenantTx(database, tenantFrom(c), (tx) =>
      listConversations(tx, actorFrom(c), student_id),
    );
    return c.json({ conversations }, 200);
  });

  routes.openapi(createConversationRoute, async (c) => {
    requireParent(c);
    const { student_id, teacher_id } = c.req.valid("json");
    const { conversation, created } = await withTenantTx(database, tenantFrom(c), (tx) =>
      getOrCreateConversation(tx, actorFrom(c), {
        studentId: student_id,
        teacherUserId: teacher_id,
      }),
    );
    return created ? c.json({ conversation }, 201) : c.json({ conversation }, 200);
  });

  routes.openapi(teacherContactsRoute, async (c) => {
    requireTeacher(c);
    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      listTeacherContacts(tx, actorFrom(c)),
    );
    return c.json(result, 200);
  });

  routes.openapi(createTeacherConversationRoute, async (c) => {
    requireTeacher(c);
    const { student_id, parent_id } = c.req.valid("json");
    const { conversation, created } = await withTenantTx(database, tenantFrom(c), (tx) =>
      getOrCreateTeacherConversation(tx, actorFrom(c), {
        studentId: student_id,
        parentUserId: parent_id,
      }),
    );
    return created ? c.json({ conversation }, 201) : c.json({ conversation }, 200);
  });

  routes.openapi(getConversationRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    const conversation = await withTenantTx(database, tenantFrom(c), (tx) =>
      getConversation(tx, actorFrom(c), conversationId),
    );
    return c.json({ conversation }, 200);
  });

  routes.openapi(listMessagesRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const page = await withTenantTx(database, tenantFrom(c), (tx) =>
      listMessages(tx, storage, actorFrom(c), conversationId, query),
    );
    return c.json(page, 200);
  });

  routes.openapi(sendMessageRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const message = await withTenantTx(database, tenantFrom(c), (tx) =>
      sendMessage(tx, storage, actorFrom(c), conversationId, input),
    );
    return c.json({ message }, 201);
  });

  routes.openapi(markReadRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    await withTenantTx(database, tenantFrom(c), (tx) =>
      markConversationRead(tx, actorFrom(c), conversationId),
    );
    return c.body(null, 204);
  });

  routes.openapi(profileRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    const profile = await withTenantTx(database, tenantFrom(c), (tx) =>
      getParticipantProfile(tx, actorFrom(c), conversationId),
    );
    return c.json({ profile }, 200);
  });

  routes.openapi(blockRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    const { state, created } = await withTenantTx(database, tenantFrom(c), (tx) =>
      blockConversationParticipant(tx, actorFrom(c), conversationId),
    );
    return created ? c.json(state, 201) : c.json(state, 200);
  });

  routes.openapi(unblockRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    await withTenantTx(database, tenantFrom(c), (tx) =>
      unblockConversationParticipant(tx, actorFrom(c), conversationId),
    );
    return c.body(null, 204);
  });

  routes.openapi(createReportRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      createMessageReport(tx, actorFrom(c), conversationId, input),
    );
    return c.json(result, 201);
  });

  routes.openapi(listReportsRoute, async (c) => {
    const query = c.req.valid("query");
    const page = await withTenantTx(database, tenantFrom(c), (tx) =>
      listMessageReports(tx, actorFrom(c), query),
    );
    return c.json(page, 200);
  });

  routes.openapi(getReportRoute, async (c) => {
    const { reportId } = c.req.valid("param");
    const report = await withTenantTx(database, tenantFrom(c), (tx) =>
      getMessageReport(tx, storage, actorFrom(c), reportId),
    );
    return c.json({ report }, 200);
  });

  routes.openapi(updateReportRoute, async (c) => {
    const { reportId } = c.req.valid("param");
    const input = c.req.valid("json");
    const report = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateMessageReport(tx, actorFrom(c), reportId, input),
    );
    return c.json({ report }, 200);
  });

  return routes;
}
