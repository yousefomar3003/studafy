import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS, STORAGE_ADDON_PLAN_CODES } from "@studafy/constants";
import { z } from "zod";

import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { createStorageCheckoutSession } from "../services/checkout-service";
import {
  changeStorageTier,
  getStorageOffer,
  setStorageAddonCancellation,
} from "../services/storage-addon-service";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";
import type { PaymentProviderRegistry } from "../payment-provider-routing";
import type { StorageAddonCurrent } from "../services/storage-addon-service";

const planCodeSchema = z.enum(STORAGE_ADDON_PLAN_CODES as [string, ...string[]]);

const StorageAddonPriceSchema = z
  .object({
    id: z.string().uuid(),
    amountMinor: z.number().int(),
    currency: z.string(),
    interval: z.enum(["monthly", "yearly"]),
  })
  .openapi("StorageAddOnPrice");

const StorageAddonCurrentSchema = z
  .object({
    planCode: planCodeSchema.nullable(),
    capBytes: z.number().int(),
    status: z.string(),
    price: StorageAddonPriceSchema.nullable(),
    currentPeriodEnd: z.string().datetime(),
    cancelAtPeriodEnd: z.boolean().openapi({
      description:
        "Set to stop at the end of the period; storage drops back to what is included then.",
    }),
  })
  .openapi("StorageAddOnCurrent");

const StorageOfferSchema = z
  .object({
    usage: z.object({
      usedBytes: z.number().int(),
      capBytes: z.number().int().openapi({
        description: "The cap uploads are held to now: the add-on's when one is live.",
      }),
      includedBytes: z.number().int(),
    }),
    current: StorageAddonCurrentSchema.nullable(),
    tiers: z.array(
      z
        .object({
          planCode: planCodeSchema,
          capBytes: z.number().int(),
          prices: z.array(StorageAddonPriceSchema),
        })
        .openapi("StorageAddOnTier"),
    ),
    currency: z.string().nullable(),
    availableOnline: z.boolean().openapi({
      description:
        "Whether this school can buy, change or cancel the add-on online. False when its payment " +
        "provider cannot manage subscriptions (Tap) or is not configured.",
    }),
  })
  .openapi("StorageAddOnOffer");

const StorageCheckoutRequestSchema = z.object({
  priceId: z.string().uuid(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const StorageCheckoutResponseSchema = z.object({
  url: z.string(),
  sessionId: z.string(),
});

const StorageChangeRequestSchema = z.object({ priceId: z.string().uuid() });

const StorageCancellationSchema = z
  .object({
    cancelAtPeriodEnd: z.boolean(),
    currentPeriodEnd: z.string().datetime(),
  })
  .openapi("StorageAddOnCancellation");

const BASE = "/api/subscriptions/storage";

const offerRoute = createRoute({
  method: "get",
  path: `${BASE}/offer`,
  tags: ["Subscriptions"],
  operationId: "getStorageAddOnOffer",
  summary: "What extra storage the school can buy",
  description:
    "The school's storage use and cap, its live storage add-on if it has one, and each tier with " +
    "its prices in the school's currency (USD when none is set in it). license:read; web only.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The offer", schema: StorageOfferSchema } },
    [401, 403],
  ),
});

const checkoutRoute = createRoute({
  method: "post",
  path: `${BASE}/checkout`,
  tags: ["Subscriptions"],
  operationId: "createStorageAddOnCheckout",
  summary: "Buy extra storage for the school",
  description:
    "Starts a hosted checkout for a storage tier price. 409 STORAGE_ADDON_ALREADY_ACTIVE when the " +
    "school already has one (change its tier instead), 409 STORAGE_ADDON_UNAVAILABLE when the " +
    "school's payment provider cannot sell it online. license:manage; web only.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: StorageCheckoutRequestSchema } } },
  },
  responses: standardResponses(
    { 200: { description: "Checkout session created", schema: StorageCheckoutResponseSchema } },
    [400, 401, 403, 404, 409, 502, 503],
  ),
});

const changeRoute = createRoute({
  method: "post",
  path: `${BASE}/change`,
  tags: ["Subscriptions"],
  operationId: "changeStorageAddOnTier",
  summary: "Change the school's storage tier",
  description:
    "Moves the live add-on to another tier or interval, prorated. More storage (or another " +
    "interval) is charged now and applied only once paid: 402 STORAGE_ADDON_PAYMENT_FAILED leaves " +
    "everything as it was. Less storage applies now and is credited on the next invoice; no file " +
    "is ever deleted. license:manage; web only.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: StorageChangeRequestSchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The add-on after the change", schema: StorageAddonCurrentSchema } },
    [400, 401, 402, 403, 404, 409, 502, 503],
  ),
});

const cancelRoute = createRoute({
  method: "post",
  path: `${BASE}/cancel`,
  tags: ["Subscriptions"],
  operationId: "cancelStorageAddOn",
  summary: "Stop the storage add-on at the end of its period",
  description:
    "The add-on and its storage last until the period ends, then the school is back on the storage " +
    "its plan includes. Files are never deleted. license:manage; web only.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Cancellation scheduled", schema: StorageCancellationSchema } },
    [401, 403, 404, 409, 502, 503],
  ),
});

const reverseCancelRoute = createRoute({
  method: "post",
  path: `${BASE}/cancel/reverse`,
  tags: ["Subscriptions"],
  operationId: "reverseStorageAddOnCancellation",
  summary: "Keep the storage add-on renewing",
  description: "Undoes a scheduled cancellation. license:manage; web only.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Cancellation undone", schema: StorageCancellationSchema } },
    [401, 403, 404, 409, 502, 503],
  ),
});

function serializeCurrent(current: StorageAddonCurrent) {
  return { ...current, currentPeriodEnd: current.currentPeriodEnd.toISOString() };
}

/**
 * The paid storage add-on (db/migrations/000205): bought, changed and canceled by the school's
 * principals and admins (license:manage, the permission that already lets them accept a license
 * quote), seen by anyone with license:read. Web only, like every purchase: the app stores allow
 * digital purchases only through their own billing.
 */
export function storageAddonRoutes(
  database: Database,
  providers: PaymentProviderRegistry,
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.use(`${BASE}/*`, requireChannel(AUTH_CHANNELS.WEB));
  app.use(`${BASE}/offer`, requirePermission(PERMISSIONS.LICENSE_READ));
  for (const path of [
    `${BASE}/checkout`,
    `${BASE}/change`,
    `${BASE}/cancel`,
    `${BASE}/cancel/reverse`,
  ]) {
    app.use(path, requirePermission(PERMISSIONS.LICENSE_MANAGE));
  }

  app.openapi(offerRoute, async (c) => {
    const auth = requireAuth(c);
    const offer = await getStorageOffer(database, providers, {
      schoolId: auth.schoolId,
      userId: auth.userId,
      requestId: c.get("requestId"),
    });
    return c.json(
      { ...offer, current: offer.current ? serializeCurrent(offer.current) : null },
      200,
    );
  });

  app.openapi(checkoutRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const result = await createStorageCheckoutSession(database, providers, {
      schoolId: auth.schoolId,
      priceId: body.priceId,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      tenantContext: {
        schoolId: auth.schoolId,
        userId: auth.userId,
        requestId: c.get("requestId"),
      },
    });
    return c.json(result, 200);
  });

  app.openapi(changeRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const current = await changeStorageTier(database, providers, {
      schoolId: auth.schoolId,
      priceId: body.priceId,
      tenantContext: {
        schoolId: auth.schoolId,
        userId: auth.userId,
        requestId: c.get("requestId"),
      },
    });
    return c.json(serializeCurrent(current), 200);
  });

  for (const [route, cancel] of [
    [cancelRoute, true],
    [reverseCancelRoute, false],
  ] as const) {
    app.openapi(route, async (c) => {
      const auth = requireAuth(c);
      const result = await setStorageAddonCancellation(database, providers, {
        schoolId: auth.schoolId,
        cancel,
        tenantContext: {
          schoolId: auth.schoolId,
          userId: auth.userId,
          requestId: c.get("requestId"),
        },
      });
      return c.json(
        {
          cancelAtPeriodEnd: result.cancelAtPeriodEnd,
          currentPeriodEnd: result.currentPeriodEnd.toISOString(),
        },
        200,
      );
    });
  }

  return app;
}
