/**
 * `POST /api/account/deletion` — self-service account deletion from account settings on iOS,
 * Android (both open the web settings page in the system browser) and web.
 *
 * Bearer-authenticated only, no permission gate: the subject is always the caller, never a
 * parameter, so there is no other user a permission check would protect (same rationale as
 * `POST /api/privacy/me/dsr`). See account-deletion-service.ts for what happens and in what order.
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
import { RETAINED_RECORD_CATEGORIES } from "./retention-policy";
import { accountDeletionResponseSchema } from "./schemas";

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

  routes.openapi(deleteAccountRoute, async (c) => {
    const auth = requireAuth(c);
    if (!maintenanceQueue) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.DSR_UNAVAILABLE,
        "Account deletion is not available on this deployment",
      );
    }

    const result = await deleteAccount(
      { database, denylist, paymentProviders, maintenanceQueue, siwa },
      {
        schoolId: auth.schoolId,
        userId: auth.userId,
        requestId: c.get("requestId"),
        log: c.get("log"),
        userAgent: c.req.header("User-Agent") ?? null,
        clientIp: clientIpFrom(c),
      },
    );

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
