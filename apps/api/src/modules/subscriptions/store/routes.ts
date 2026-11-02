import { timingSafeEqual } from "node:crypto";

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requireChannel } from "../../../middleware/channelGuard";
import { getLocalizedMessage } from "../../../middleware/locale";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";

import {
  handleAppleNotification,
  handleGooglePlayNotification,
  registerStorePurchase,
} from "./service";

import type { StoreBilling } from "./service";
import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";

const StoreConfigSchema = z
  .object({
    enabled: z.boolean(),
    productId: z.string().nullable(),
    platforms: z.object({ apple: z.boolean(), google: z.boolean() }),
    /** True when this signed-in user is a student whose school has an active Studafy plan. */
    purchasable: z.boolean(),
    /**
     * The ids the app stamps on the purchase when `purchasable`: the student's id (Apple
     * `appAccountToken`, Google `obfuscatedAccountId`) and the school's (Google
     * `obfuscatedProfileId`). The server only accepts a purchase carrying this student's id.
     */
    accountToken: z.string().uuid().nullable(),
    profileId: z.string().uuid().nullable(),
  })
  .openapi("AiStoreConfig");

const RegisterPurchaseSchema = z
  .object({
    platform: z.enum(["apple", "google"]),
    /** Apple: the transaction's JWS (StoreKit 2 jwsRepresentation). Google: the purchase token. */
    verificationData: z.string().min(1).max(20_000),
  })
  .openapi("AiStorePurchaseRequest");

const PurchaseResultSchema = z
  .object({ active: z.boolean(), expiresAt: z.string().datetime().nullable() })
  .openapi("AiStorePurchaseResult");

const NotificationResultSchema = z.object({ received: z.literal(true), outcome: z.string() });

const storeConfigRoute = createRoute({
  method: "get",
  path: "/api/subscriptions/ai/store/config",
  tags: ["Subscriptions"],
  operationId: "getAiStoreConfig",
  summary: "In-app purchase setup for the AI add-on",
  description:
    "Whether the AI add-on can be bought in the mobile app, which store product to offer, and " +
    "whether this signed-in user may buy it (a student whose school has an active plan).",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Store setup", schema: StoreConfigSchema } },
    [401],
  ),
});

const registerPurchaseRoute = createRoute({
  method: "post",
  path: "/api/subscriptions/ai/store/purchases",
  tags: ["Subscriptions"],
  operationId: "registerAiStorePurchase",
  summary: "Register an AI add-on bought in the app",
  description:
    "Called by the mobile app when an App Store or Google Play purchase of the AI add-on " +
    "completes, and again by 'restore purchases'. The purchase is verified with the store, must " +
    "carry this student's account id, and turns the student's AI add-on on. Idempotent. Mobile " +
    "sessions only.",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: RegisterPurchaseSchema } } } },
  responses: standardResponses(
    { 200: { description: "Purchase registered", schema: PurchaseResultSchema } },
    [400, 401, 403, 409, 503],
  ),
});

const appleNotificationRoute = createRoute({
  method: "post",
  // Literal, not a constant: tests/audit-coverage.test.ts reads route paths as text.
  path: "/api/subscriptions/webhook/apple",
  tags: ["Subscriptions"],
  operationId: "receiveAppleStoreNotification",
  summary: "Receive App Store Server Notifications V2",
  description:
    "Renewals, billing failures, expiry and refunds of AI add-on subscriptions bought on iOS. " +
    "Authenticated by Apple's signature over the payload (verified against Apple's root " +
    "certificates), not by a bearer token. Deduplicated on the notification UUID.",
  security: [],
  request: {
    body: {
      content: {
        "application/json": { schema: z.object({ signedPayload: z.string().min(1) }) },
      },
    },
  },
  responses: standardResponses(
    { 200: { description: "Notification accepted", schema: NotificationResultSchema } },
    [400, 503],
  ),
});

const googleNotificationRoute = createRoute({
  method: "post",
  path: "/api/subscriptions/webhook/google",
  tags: ["Subscriptions"],
  operationId: "receiveGooglePlayNotification",
  summary: "Receive Google Play Real-time Developer Notifications",
  description:
    "A Cloud Pub/Sub push of Play's subscription notifications for AI add-ons bought on Android. " +
    "Authenticated by the secret `token` in the push endpoint's URL; the subscription itself is " +
    "then read back from the Play Developer API, never trusted from the message. Deduplicated on " +
    "the Pub/Sub message id.",
  security: [],
  request: { query: z.object({ token: z.string().optional() }) },
  responses: standardResponses(
    { 200: { description: "Notification accepted", schema: NotificationResultSchema } },
    [400, 401, 503],
  ),
});

export function aiStoreRoutes(
  database: Database,
  store: StoreBilling | null,
  logger: Logger,
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.use("/api/subscriptions/ai/store/purchases", requireChannel(AUTH_CHANNELS.MOBILE));
  app.use("/api/subscriptions/ai/store/purchases", auditAction("update", "ai_subscriptions"));
  app.use("/api/subscriptions/webhook/apple", auditAction("update", "ai_subscriptions"));
  app.use("/api/subscriptions/webhook/google", auditAction("update", "ai_subscriptions"));

  const notConfigured = (locale: SupportedLocale) =>
    new CodedHttpException(
      503,
      ERROR_CODES.STORE_BILLING_NOT_CONFIGURED,
      getLocalizedMessage(ERROR_CODES.STORE_BILLING_NOT_CONFIGURED, locale),
    );

  app.openapi(storeConfigRoute, async (c) => {
    const auth = requireAuth(c);
    const enabled = store !== null && (store.apple !== null || store.google !== null);
    let student: { id: string } | null = null;
    if (enabled) {
      // A student of a school whose own plan is live: the add-on works only on top of that, so
      // selling it otherwise would take money for nothing.
      const [row] = await withTenantTx(
        database,
        { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
        (tx) => tx<{ id: string }[]>`
          SELECT s.id FROM app.students s
          WHERE s.user_id = ${auth.userId}::uuid
            AND EXISTS (
              SELECT 1 FROM app.subscriptions
              WHERE school_id = ${auth.schoolId}::uuid
                AND status IN ('trialing', 'active', 'past_due', 'grace_period')
            )
          LIMIT 1
        `,
      );
      student = row ?? null;
    }
    return c.json(
      {
        enabled,
        productId: enabled ? store!.productId : null,
        platforms: { apple: store?.apple != null, google: store?.google != null },
        purchasable: student !== null,
        accountToken: student?.id ?? null,
        profileId: student ? auth.schoolId : null,
      },
      200,
    );
  });

  app.openapi(registerPurchaseRoute, async (c) => {
    const auth = requireAuth(c);
    const locale = (c.get("locale") ?? "en") as SupportedLocale;
    if (!store) throw notConfigured(locale);
    const body = c.req.valid("json");
    const result = await registerStorePurchase(database, store, logger, {
      schoolId: auth.schoolId,
      userId: auth.userId,
      requestId: c.get("requestId"),
      platform: body.platform,
      verificationData: body.verificationData,
      locale,
    });
    return c.json(result, 200);
  });

  app.openapi(appleNotificationRoute, async (c) => {
    if (!store) throw notConfigured("en");
    const { signedPayload } = c.req.valid("json");
    const outcome = await handleAppleNotification(database, store, logger, signedPayload);
    return c.json({ received: true as const, outcome }, 200);
  });

  app.openapi(googleNotificationRoute, async (c) => {
    if (!store) throw notConfigured("en");
    const { token } = c.req.valid("query");
    if (!sameSecret(token, store.googleNotificationToken)) {
      throw new CodedHttpException(
        401,
        ERROR_CODES.STORE_WEBHOOK_INVALID,
        getLocalizedMessage(ERROR_CODES.STORE_WEBHOOK_INVALID, "en"),
      );
    }
    const outcome = await handleGooglePlayNotification(database, store, logger, await c.req.json());
    return c.json({ received: true as const, outcome }, 200);
  });

  return app;
}

/** Constant-time comparison of the push URL's token, so its value cannot be found by timing. */
function sameSecret(given: string | undefined, expected: string | null): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
