/**
 * `POST /api/account/deletion` — self-service account deletion from account settings in the
 * mobile app and on the web. Schedules the deletion 14 days out and signs out everywhere;
 * `DELETE /api/account/deletion` cancels it during that grace period.
 *
 * Bearer-authenticated only, no permission gate: the subject is always the caller, never a
 * parameter, so there is no other user a permission check would protect (same rationale as
 * `POST /api/privacy/me/dsr`). See account-deletion-service.ts for what happens and in what order.
 * Member-password accounts confirm with their own member ID and password.
 *
 * `POST /api/account/deletion-requests` and `.../confirm` — the same deletion, requested from the
 * public page at /legal/delete-account without the app or a session (ST-302). Unauthenticated;
 * the emailed one-time token is the credential. See deletion-request-service.ts.
 *
 * `GET /api/account/profile` — the caller's own name and school, for the portal home header. Same
 * no-permission-gate rationale: the subject is always the caller.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { withTenantTx } from "../../db/tenant-tx";
import { clientIpFrom } from "../../lib/client-ip";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { openApiValidationHook } from "../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../openapi/responses";

import { cancelAccountDeletion, scheduleAccountDeletion } from "./account-deletion-service";
import { confirmAccountDeletion, requestAccountDeletion } from "./deletion-request-service";
import { getAccountProfile } from "./profile-service";
import { RETAINED_RECORD_CATEGORIES } from "./retention-policy";
import {
  accountDeletionBodySchema,
  accountDeletionConfirmBodySchema,
  accountDeletionConfirmResponseSchema,
  accountDeletionRequestBodySchema,
  accountDeletionRequestResponseSchema,
  accountDeletionResponseSchema,
  accountProfileSchema,
} from "./schemas";

import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { RedisClient } from "../../redis";
import type { JtiDenylist } from "../auth/denylist";

const getProfileRoute = createRoute({
  method: "get",
  path: "/api/account/profile",
  tags: ["Account"],
  operationId: "getOwnAccountProfile",
  summary: "Get the caller's own profile",
  description:
    "Returns the caller's display name, contact address, member IDs, any scheduled deletion and " +
    "the school the session is signed in to. Resolved from the session's user, so every role can " +
    "load it without a permission.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The caller's own profile.", schema: accountProfileSchema } },
    [401, 404, 500],
  ),
});

const deleteAccountRoute = createRoute({
  method: "post",
  path: "/api/account/deletion",
  tags: ["Account"],
  operationId: "deleteOwnAccount",
  summary: "Schedule deletion of the caller's own account",
  description:
    "Signs the caller out everywhere and schedules the deletion for `scheduled_for` (14 days). " +
    "Until then, signing in again allows only cancelling it. On that date the account is " +
    "detached from the school, AI add-on billing stops and an erasure request is filed; personal " +
    "data is erased by `completes_by`. `retained_records` lists the only records kept, and why. " +
    "Member-password accounts must send their own `member_id` and `password`.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: accountDeletionBodySchema } },
    },
  },
  responses: standardResponses(
    { 202: { description: "Deletion scheduled.", schema: accountDeletionResponseSchema } },
    [401, 403, 404, 409, 422, 503, 500],
  ),
});

const cancelDeletionRoute = createRoute({
  method: "delete",
  path: "/api/account/deletion",
  tags: ["Account"],
  operationId: "cancelOwnAccountDeletion",
  summary: "Cancel the caller's scheduled account deletion",
  description:
    "Cancels a deletion scheduled by POST /api/account/deletion while its grace period is still " +
    "running. Refresh the access token afterwards to leave the cancel-only session.",
  security: [{ bearerAuth: [] }],
  responses: {
    204: { description: "Deletion cancelled.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 409, 500]),
  },
});

const requestDeletionRoute = createRoute({
  method: "post",
  path: "/api/account/deletion-requests",
  tags: ["Account"],
  operationId: "requestAccountDeletion",
  summary: "Email a one-time account deletion link",
  description:
    "Public. If the address has any Studafy accounts, emails a link (valid one hour) that deletes " +
    "them. The response is identical whether or not it does, and at most one email is sent per " +
    "address every five minutes. Protected by Turnstile and rate limiting.",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: accountDeletionRequestBodySchema } },
    },
  },
  responses: standardResponses(
    { 202: { description: "Request accepted.", schema: accountDeletionRequestResponseSchema } },
    [400, 429, 503, 500],
  ),
});

const confirmDeletionRoute = createRoute({
  method: "post",
  path: "/api/account/deletion-requests/confirm",
  tags: ["Account"],
  operationId: "confirmAccountDeletion",
  summary: "Delete the accounts an emailed link was issued for",
  description:
    "Public; the token from the emailed link is the credential. Schedules the deletion of every " +
    "active account under that address exactly as `POST /api/account/deletion` does, and " +
    "consumes the token.",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: accountDeletionConfirmBodySchema } },
    },
  },
  responses: standardResponses(
    { 202: { description: "Deletion accepted.", schema: accountDeletionConfirmResponseSchema } },
    [400, 409, 429, 502, 503, 500],
  ),
});

const retainedRecords = RETAINED_RECORD_CATEGORIES.map((c) => ({
  category: c.category,
  description: c.description,
  legal_basis: c.legalBasis,
}));

export function accountRoutes(
  database: Database,
  redis: RedisClient | null,
  denylist: JtiDenylist | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/account/deletion", auditAction("update", "users"));
  // The request writes no audit row (see deletion-request-service.ts); the deletion it leads to is
  // audited on confirm, inside scheduleAccountDeletion's transaction.
  routes.use("/api/account/deletion-requests", auditAction("delete", "users"));
  routes.use("/api/account/deletion-requests/confirm", auditAction("delete", "users"));

  const requireDeletionDeps = () => {
    if (!redis) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.DSR_UNAVAILABLE,
        "Account deletion is not available on this deployment",
      );
    }
    return {
      database,
      denylist,
      redis,
      captchaSecretKey: process.env.TURNSTILE_SECRET_KEY,
    };
  };

  routes.openapi(requestDeletionRoute, async (c) => {
    const body = c.req.valid("json");
    await requestAccountDeletion(requireDeletionDeps(), {
      email: body.email,
      captchaToken: body.captcha_token,
      clientIp: clientIpFrom(c),
      requestId: c.get("requestId"),
      log: c.get("log"),
    });
    return c.json(
      {
        message:
          "If this address has a Studafy account, we have sent it a link to confirm the deletion.",
      },
      202,
    );
  });

  routes.openapi(confirmDeletionRoute, async (c) => {
    const body = c.req.valid("json");
    const confirmed = await confirmAccountDeletion(requireDeletionDeps(), {
      token: body.token,
      clientIp: clientIpFrom(c),
      userAgent: c.req.header("User-Agent") ?? null,
      requestId: c.get("requestId"),
      log: c.get("log"),
    });
    return c.json(
      {
        accounts: confirmed.map((a) => ({
          school_name: a.schoolName,
          scheduled_for: a.scheduledFor.toISOString(),
          completes_by: a.completesBy.toISOString(),
        })),
        retained_records: retainedRecords,
      },
      202,
    );
  });

  routes.openapi(getProfileRoute, async (c) => {
    const auth = requireAuth(c);
    const row = await withTenantTx(
      database,
      { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      (tx) => getAccountProfile(tx, auth.schoolId, auth.userId),
    );
    if (!row) {
      throw new HTTPException(404, { message: "User not found" });
    }
    return c.json(
      {
        user_id: row.user_id,
        display_name: row.display_name,
        email: row.email,
        member_ids: row.member_ids,
        deletion_scheduled_for: row.deletion_due_at?.toISOString() ?? null,
        deletion_requires_member_credentials: row.deletion_requires_member_credentials,
        school: { id: row.school_id, name: row.school_name },
      },
      200,
    );
  });

  routes.openapi(deleteAccountRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json") ?? {};

    const result = await scheduleAccountDeletion(
      { database, denylist },
      {
        schoolId: auth.schoolId,
        userId: auth.userId,
        memberId: body.member_id,
        password: body.password,
        requestId: c.get("requestId"),
        log: c.get("log"),
        userAgent: c.req.header("User-Agent") ?? null,
        clientIp: clientIpFrom(c),
      },
    );

    return c.json(
      {
        status: "scheduled" as const,
        requested_at: result.requestedAt.toISOString(),
        scheduled_for: result.scheduledFor.toISOString(),
        completes_by: result.completesBy.toISOString(),
        retained_records: retainedRecords,
      },
      202,
    );
  });

  routes.openapi(cancelDeletionRoute, async (c) => {
    const auth = requireAuth(c);
    await cancelAccountDeletion(database, {
      schoolId: auth.schoolId,
      userId: auth.userId,
      requestId: c.get("requestId"),
      userAgent: c.req.header("User-Agent") ?? null,
      clientIp: clientIpFrom(c),
    });
    return c.body(null, 204);
  });

  return routes;
}
