/**
 * `POST /api/account/deletion` — self-service account deletion from account settings on iOS,
 * Android (both open the web settings page in the system browser) and web.
 *
 * Bearer-authenticated only, no permission gate: the subject is always the caller, never a
 * parameter, so there is no other user a permission check would protect (same rationale as
 * `POST /api/privacy/me/dsr`). See account-deletion-service.ts for what happens and in what order.
 *
 * `POST /api/account/deletion-requests` and `.../confirm` — the same deletion, requested from the
 * public page at /legal/delete-account without the app or a session (ST-302). Unauthenticated;
 * the emailed one-time token is the credential. See deletion-request-service.ts.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import { CodedHttpException } from "../../coded-http-exception";
import { clientIpFrom } from "../../lib/client-ip";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import { deleteAccount } from "./account-deletion-service";
import { confirmAccountDeletion, requestAccountDeletion } from "./deletion-request-service";
import { RETAINED_RECORD_CATEGORIES } from "./retention-policy";
import {
  accountDeletionConfirmBodySchema,
  accountDeletionConfirmResponseSchema,
  accountDeletionRequestBodySchema,
  accountDeletionRequestResponseSchema,
  accountDeletionResponseSchema,
} from "./schemas";

import type { SiwaTokenRevocation } from "./account-deletion-service";
import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { RedisClient } from "../../redis";
import type { JtiDenylist } from "../auth/denylist";
import type { PaymentProviderRegistry } from "../subscriptions/payment-provider-routing";

const deleteAccountRoute = createRoute({
  method: "post",
  path: "/api/account/deletion",
  tags: ["Account"],
  operationId: "deleteOwnAccount",
  summary: "Delete the caller's own account",
  description:
    "Immediately signs the caller out everywhere, detaches the account from the school, stops AI " +
    "add-on billing and files an erasure request. Personal data is erased by `completes_by`; " +
    "`retained_records` lists the only records kept, and why.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 202: { description: "Deletion accepted.", schema: accountDeletionResponseSchema } },
    [401, 409, 502, 503, 500],
  ),
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
    "Public; the token from the emailed link is the credential. Deletes every active account under " +
    "that address exactly as `POST /api/account/deletion` does, and consumes the token.",
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
  paymentProviders: PaymentProviderRegistry,
  siwa: SiwaTokenRevocation | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const maintenanceQueue = redis
    ? new Queue(QUEUE_NAMES.MAINTENANCE, { connection: redis as never })
    : null;

  routes.use("/api/account/deletion", auditAction("delete", "users"));
  // The request writes no audit row (see deletion-request-service.ts); the deletion it leads to is
  // audited on confirm, inside deleteAccount's transaction.
  routes.use("/api/account/deletion-requests", auditAction("delete", "users"));
  routes.use("/api/account/deletion-requests/confirm", auditAction("delete", "users"));

  const requireDeletionDeps = () => {
    if (!redis || !maintenanceQueue) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.DSR_UNAVAILABLE,
        "Account deletion is not available on this deployment",
      );
    }
    return {
      database,
      denylist,
      paymentProviders,
      maintenanceQueue,
      siwa,
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
          request_id: a.requestId,
          completes_by: a.completesBy.toISOString(),
        })),
        retained_records: retainedRecords,
      },
      202,
    );
  });

  routes.openapi(deleteAccountRoute, async (c) => {
    const auth = requireAuth(c);

    const result = await deleteAccount(requireDeletionDeps(), {
      schoolId: auth.schoolId,
      userId: auth.userId,
      requestId: c.get("requestId"),
      log: c.get("log"),
      userAgent: c.req.header("User-Agent") ?? null,
      clientIp: clientIpFrom(c),
    });

    return c.json(
      {
        request_id: result.request.id,
        status: result.request.status,
        requested_at: result.request.createdAt.toISOString(),
        completes_by: result.request.slaDueAt.toISOString(),
        ai_subscriptions_canceled: result.aiSubscriptionsCanceled,
        retained_records: retainedRecords,
      },
      202,
    );
  });

  return routes;
}
