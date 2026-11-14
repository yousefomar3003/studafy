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
  readStoreOffer,
  readStorePurchaseConfirmation,
  registerStorePurchase,
  storeProductIds,
} from "./service";

import type { StoreBilling, StorePurchaseConfirmation } from "./service";
import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";

const StoreConfigSchema = z
  .object({
    enabled: z.boolean(),
    /**
     * The product to buy for this student. One store account can hold only one subscription to a
     * product, so a brother or sister already holding the first one is offered the next.
     */
    productId: z.string().nullable(),
    /** Every product the add-on is sold under, primary first. */
    productIds: z.array(z.string()),
    platforms: z.object({ apple: z.boolean(), google: z.boolean() }),
    /**
     * True when the add-on can be bought for this student: the signed-in student, or the child a
     * parent asked about (`studentId`), whose school has an active Studafy plan, with a product left.
     */
    purchasable: z.boolean(),
    /** The student the offer is for, and their first name for "AI for <name>". */
    studentId: z.string().uuid().nullable(),
    studentFirstName: z.string().nullable(),
    /** Whether that student's AI add-on is on right now, however it was paid for. */
    subscribed: z.boolean(),
    /** Why it cannot be bought, for the app to say so rather than show nothing. */
    unavailableReason: z
      .enum(["not_configured", "not_student", "school_plan_inactive", "no_free_product"])
      .nullable()
      .openapi({ description: "Null when it can be bought." }),
    /**
     * The ids the app stamps on the purchase when `purchasable`: the student's id (Apple
     * `appAccountToken`, Google `obfuscatedAccountId`) and the school's (Google
     * `obfuscatedProfileId`). The server only accepts a purchase carrying this student's id.
     */
    accountToken: z.string().uuid().nullable(),
    profileId: z.string().uuid().nullable(),
    /**
     * The in-app copy of the last in-app purchase's withdrawal-waiver confirmation (000195): what
     * the student was also emailed, or -- for an account without an email address -- the
     * confirmation itself. Null when none was recorded. Inline, not a named component: a nullable
     * `$ref` loses its nullability on the way to the generated Dart client.
     */
    purchaseConfirmation: z
      .object({
        acknowledgedAt: z.string().datetime(),
        recordedAt: z.string().datetime(),
        termsVersion: z.string(),
        confirmation: z.enum(["email", "in_app"]).openapi("AiStoreWaiverConfirmation"),
      })
      .nullable(),
  })
  .openapi("AiStoreConfig");

const RegisterPurchaseSchema = z
  .object({
    platform: z.enum(["apple", "google"]),
    /** Apple: the transaction's JWS (StoreKit 2 jwsRepresentation). Google: the purchase token. */
    verificationData: z.string().min(1).max(20_000),
    // Nullable as well as optional: the generated Dart client sends an unset field as null.
    withdrawalWaiverAcknowledged: z
      .boolean()
      .nullish()
      .openapi({
        description:
          "True when the student, before the store's purchase sheet opened, asked for the add-on to " +
          "start now and acknowledged losing the 14-day right of withdrawal once it does. Sent with " +
          "a new purchase only; omitted (or null) for 'restore purchases' and from app versions that " +
          "do not ask, in which case nothing is recorded. When present it must be true, with " +
          "withdrawalWaiverAcknowledgedAt.",
      }),
    withdrawalWaiverAcknowledgedAt: z.string().datetime({ offset: true }).nullish().openapi({
      description: "When the student gave that acknowledgement (ISO 8601).",
    }),
  })
  .refine(
    (body) =>
      body.withdrawalWaiverAcknowledged == null
        ? body.withdrawalWaiverAcknowledgedAt == null
        : body.withdrawalWaiverAcknowledged && body.withdrawalWaiverAcknowledgedAt != null,
    {
      message:
        "withdrawalWaiverAcknowledged must be true and sent with withdrawalWaiverAcknowledgedAt, " +
        "or both omitted",
      path: ["withdrawalWaiverAcknowledged"],
    },
  )
  .openapi("AiStorePurchaseRequest");

const PurchaseResultSchema = z
  .object({
    active: z.boolean(),
    expiresAt: z.string().datetime().nullable(),
    /** The student the purchase turned AI on for: the one it was bought for. */
    studentId: z.string().uuid(),
  })
  .openapi("AiStorePurchaseResult");

const NotificationResultSchema = z.object({ received: z.literal(true), outcome: z.string() });

const storeConfigRoute = createRoute({
  method: "get",
  path: "/api/subscriptions/ai/store/config",
  tags: ["Subscriptions"],
  operationId: "getAiStoreConfig",
  summary: "In-app purchase setup for the AI add-on",
  description:
    "Whether the AI add-on can be bought in the mobile app, which store product to offer, " +
    "whether it can be bought for this student (the signed-in student, or with `studentId` a " +
    "child linked to the signed-in parent) and why not, and the confirmation of the last in-app " +
    "purchase's withdrawal waiver, if one was recorded.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      studentId: z.string().uuid().optional().openapi({
        description: "A parent's child to buy for. Omitted: the signed-in student.",
      }),
    }),
  },
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
    "carry this student's account id, and turns the student's AI add-on on. A new purchase " +
    "carries the student's waiver of the 14-day right of withdrawal, which is recorded with the " +
    "Terms of Service version and confirmed to the student by email (or in the app, for an " +
    "account without one). Idempotent. Mobile sessions only.",
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
    const { studentId } = c.req.valid("query");
    const enabled = store !== null && (store.apple !== null || store.google !== null);
    // A school whose own plan is not live is "school_plan_inactive": the add-on works only on top of
    // that plan, so selling it otherwise would take money for nothing.
    const offer = await readStoreOffer(database, store, {
      schoolId: auth.schoolId,
      userId: auth.userId,
      studentId,
    });
    const purchasable = offer.unavailableReason === null;
    let purchaseConfirmation: StorePurchaseConfirmation | null = null;
    if (offer.studentId) {
      const target = offer.studentId;
      purchaseConfirmation = await withTenantTx(
        database,
        { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
        (tx) => readStorePurchaseConfirmation(tx, target),
      );
    }
    return c.json(
      {
        enabled,
        productId: purchasable ? offer.productId : null,
        productIds: enabled ? [...storeProductIds(store!)] : [],
        platforms: { apple: store?.apple != null, google: store?.google != null },
        purchasable,
        studentId: offer.studentId,
        studentFirstName: offer.studentFirstName,
        subscribed: offer.subscribed,
        unavailableReason: offer.unavailableReason,
        accountToken: purchasable ? offer.studentId : null,
        profileId: purchasable ? auth.schoolId : null,
        purchaseConfirmation,
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
      withdrawalWaiver:
        body.withdrawalWaiverAcknowledged && body.withdrawalWaiverAcknowledgedAt
          ? { acknowledgedAt: new Date(body.withdrawalWaiverAcknowledgedAt) }
          : null,
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
