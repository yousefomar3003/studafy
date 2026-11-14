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
  createStoragePaymentMethodSession,
  getStorageBilling,
  getStorageOffer,
  previewStorageTierChange,
  setStorageAddonCancellation,
  undoScheduledStorageChange,
} from "../services/storage-addon-service";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";
import type { PaymentProviderRegistry } from "../payment-provider-routing";
import type { StorageAddonCurrent, StorageBillingDetails } from "../services/storage-addon-service";

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
    pendingChange: z
      .object({
        planCode: planCodeSchema.nullable(),
        capBytes: z.number().int(),
        price: StorageAddonPriceSchema.nullable(),
        effectiveAt: z.string().datetime(),
      })
      .nullable()
      .openapi({
        description:
          "A move to less storage or to the other billing interval, taking effect at the next " +
          "renewal (nothing charged or credited now). Undo with POST /change/undo.",
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
    granted: z
      .object({
        capBytes: z.number().int(),
        endsAt: z.string().datetime(),
      })
      .openapi("StorageAddOnGrant", {
        description:
          "Storage Studafy granted by hand (for example after a cash payment), in force now. The " +
          "cap uploads are held to is the largest of the included storage, a live add-on and this.",
      })
      .nullable(),
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

const StorageChangePreviewRequestSchema = z.object({ priceId: z.string().uuid() });

const StorageChangePreviewSchema = z
  .object({
    timing: z.enum(["now", "renewal"]).openapi({
      description:
        "now: more storage on the same interval, applied and charged at once. renewal: less " +
        "storage or the other interval, applied at the next renewal with nothing charged now.",
    }),
    effectiveAt: z.string().datetime(),
    amountDueNowMinor: z
      .number()
      .int()
      .openapi({
        description:
          "Charged the moment the change is confirmed, prorated: the new price for the rest of the " +
          "period less the unused part of the current one. 0 for a change at renewal.",
      }),
    nextBillMinor: z.number().int().openapi({
      description: "The next regular bill, at the new price.",
    }),
    nextBillAt: z.string().datetime(),
    currency: z.string(),
    chargeNow: z.boolean(),
    price: StorageAddonPriceSchema,
    capBytes: z.number().int(),
    prorationDate: z.string().datetime().openapi({
      description: "Send back with the change, with amountDueNowMinor as expectedAmountMinor.",
    }),
  })
  .openapi("StorageAddOnChangePreview");

const StorageChangeRequestSchema = z.object({
  priceId: z.string().uuid(),
  prorationDate: z.string().datetime().openapi({
    description: "The preview's prorationDate. A preview older than 30 minutes is refused.",
  }),
  expectedAmountMinor: z
    .number()
    .int()
    .min(0)
    .openapi({
      description:
        "The preview's amountDueNowMinor, as the school confirmed it. When the change would now cost " +
        "anything else, nothing is charged: 409 STORAGE_ADDON_PRICE_CHANGED.",
    }),
  requestKey: z.string().uuid().openapi({
    description: "One per confirmation. Repeating a request with the same key never charges twice.",
  }),
});

const StorageCancellationSchema = z
  .object({
    cancelAtPeriodEnd: z.boolean(),
    currentPeriodEnd: z.string().datetime(),
  })
  .openapi("StorageAddOnCancellation");

const PaymentMethodSchema = z
  .object({
    brand: z.string(),
    last4: z.string().nullable(),
    expMonth: z.number().int().nullable(),
    expYear: z.number().int().nullable(),
  })
  .openapi("StorageAddOnPaymentMethod");

export const StorageInvoiceSchema = z
  .object({
    id: z.string(),
    number: z.string().nullable(),
    status: z.string().nullable(),
    created: z.string().datetime(),
    amountDueMinor: z.number().int(),
    amountPaidMinor: z.number().int(),
    amountRefundedMinor: z.number().int(),
    currency: z.string(),
    billingReason: z.string().nullable(),
    hostedInvoiceUrl: z.string().nullable(),
    invoicePdf: z.string().nullable(),
  })
  .openapi("StorageAddOnInvoice");

const StorageBillingSchema = z
  .object({
    paymentMethod: PaymentMethodSchema.nullable(),
    nextBill: z
      .object({ amountMinor: z.number().int(), currency: z.string(), at: z.string().datetime() })
      .nullable(),
    invoices: z.array(StorageInvoiceSchema),
  })
  .openapi("StorageAddOnBilling");

const PaymentMethodSessionRequestSchema = z.object({ returnUrl: z.string().url() });

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
    "school already has one (change its tier instead), 409 STORAGE_ADDON_PURCHASE_PENDING when a " +
    "storage payment is already paid or open at the provider (its confirmation still on the way; " +
    "earlier open checkouts are closed first, so only one can ever be paid), 409 " +
    "STORAGE_ADDON_UNAVAILABLE when the " +
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

const previewChangeRoute = createRoute({
  method: "post",
  path: `${BASE}/change/preview`,
  tags: ["Subscriptions"],
  operationId: "previewStorageAddOnChange",
  summary: "What changing the school's storage tier will cost",
  description:
    "The exact prorated amount charged now and the next bill, from the payment provider's own " +
    "invoice preview. Nothing is charged or changed. license:manage; web only.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: StorageChangePreviewRequestSchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The cost of the change", schema: StorageChangePreviewSchema } },
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
    "Moves the live add-on to another tier or interval, prorated, for exactly the amount the " +
    "school confirmed from the preview (409 STORAGE_ADDON_PRICE_CHANGED, nothing charged, when it " +
    "would now cost anything else). More storage (or another " +
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

const undoChangeRoute = createRoute({
  method: "post",
  path: `${BASE}/change/undo`,
  tags: ["Subscriptions"],
  operationId: "undoStorageAddOnScheduledChange",
  summary: "Undo the storage change scheduled for the next renewal",
  description:
    "The add-on carries on as it is. 409 STORAGE_ADDON_NO_PENDING_CHANGE when none is scheduled. " +
    "license:manage; web only.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The add-on", schema: StorageAddonCurrentSchema } },
    [401, 403, 409, 502, 503],
  ),
});

const billingRoute = createRoute({
  method: "get",
  path: `${BASE}/billing`,
  tags: ["Subscriptions"],
  operationId: "getStorageAddOnBilling",
  summary: "The storage add-on's card, next bill and invoices",
  description:
    "From the payment provider: the payment method, the next regular bill and the add-on's " +
    "invoices with receipt links. null when the school has no storage add-on. license:manage; " +
    "web only.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Billing details", schema: StorageBillingSchema.nullable() } },
    [401, 403, 409, 502, 503],
  ),
});

const paymentMethodRoute = createRoute({
  method: "post",
  path: `${BASE}/payment-method`,
  tags: ["Subscriptions"],
  operationId: "createStorageAddOnPaymentMethodSession",
  summary: "Replace the card the storage add-on is paid with",
  description:
    "A hosted page where the school replaces its card, and nothing else: plans are changed and " +
    "canceled only in Studafy. license:manage; web only.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: PaymentMethodSessionRequestSchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The page to open", schema: z.object({ url: z.string() }) } },
    [400, 401, 403, 409, 502, 503],
  ),
});

export function serializeCurrent(current: StorageAddonCurrent) {
  return {
    ...current,
    currentPeriodEnd: current.currentPeriodEnd.toISOString(),
    pendingChange: current.pendingChange
      ? { ...current.pendingChange, effectiveAt: current.pendingChange.effectiveAt.toISOString() }
      : null,
  };
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

  app.use("/api/subscriptions/storage/*", requireChannel(AUTH_CHANNELS.WEB));
  app.use("/api/subscriptions/storage/offer", requirePermission(PERMISSIONS.LICENSE_READ));
  app.use("/api/subscriptions/storage/checkout", requirePermission(PERMISSIONS.LICENSE_MANAGE));
  app.use("/api/subscriptions/storage/change", requirePermission(PERMISSIONS.LICENSE_MANAGE));
  app.use(
    "/api/subscriptions/storage/change/preview",
    requirePermission(PERMISSIONS.LICENSE_MANAGE),
  );
  app.use("/api/subscriptions/storage/change/undo", requirePermission(PERMISSIONS.LICENSE_MANAGE));
  app.use("/api/subscriptions/storage/billing", requirePermission(PERMISSIONS.LICENSE_MANAGE));
  app.use(
    "/api/subscriptions/storage/payment-method",
    requirePermission(PERMISSIONS.LICENSE_MANAGE),
  );
  app.use("/api/subscriptions/storage/cancel", requirePermission(PERMISSIONS.LICENSE_MANAGE));
  app.use(
    "/api/subscriptions/storage/cancel/reverse",
    requirePermission(PERMISSIONS.LICENSE_MANAGE),
  );

  app.openapi(offerRoute, async (c) => {
    const auth = requireAuth(c);
    const offer = await getStorageOffer(database, providers, {
      schoolId: auth.schoolId,
      userId: auth.userId,
      requestId: c.get("requestId"),
    });
    return c.json(
      {
        ...offer,
        current: offer.current ? serializeCurrent(offer.current) : null,
        granted: offer.granted
          ? { capBytes: offer.granted.capBytes, endsAt: offer.granted.endsAt.toISOString() }
          : null,
      },
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

  app.openapi(previewChangeRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const preview = await previewStorageTierChange(database, providers, {
      schoolId: auth.schoolId,
      priceId: body.priceId,
      tenantContext: {
        schoolId: auth.schoolId,
        userId: auth.userId,
        requestId: c.get("requestId"),
      },
    });
    return c.json(
      {
        ...preview,
        effectiveAt: preview.effectiveAt.toISOString(),
        nextBillAt: preview.nextBillAt.toISOString(),
        prorationDate: preview.prorationDate.toISOString(),
      },
      200,
    );
  });

  app.openapi(changeRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const current = await changeStorageTier(database, providers, {
      schoolId: auth.schoolId,
      priceId: body.priceId,
      prorationDate: new Date(body.prorationDate),
      expectedAmountMinor: body.expectedAmountMinor,
      requestKey: body.requestKey,
      tenantContext: {
        schoolId: auth.schoolId,
        userId: auth.userId,
        requestId: c.get("requestId"),
      },
    });
    return c.json(serializeCurrent(current), 200);
  });

  app.openapi(undoChangeRoute, async (c) => {
    const auth = requireAuth(c);
    const current = await undoScheduledStorageChange(database, providers, {
      schoolId: auth.schoolId,
      tenantContext: {
        schoolId: auth.schoolId,
        userId: auth.userId,
        requestId: c.get("requestId"),
      },
    });
    return c.json(serializeCurrent(current), 200);
  });

  app.openapi(billingRoute, async (c) => {
    const auth = requireAuth(c);
    const billing = await getStorageBilling(database, providers, {
      schoolId: auth.schoolId,
      tenantContext: {
        schoolId: auth.schoolId,
        userId: auth.userId,
        requestId: c.get("requestId"),
      },
    });
    return c.json(billing ? serializeBilling(billing) : null, 200);
  });

  app.openapi(paymentMethodRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const session = await createStoragePaymentMethodSession(database, providers, {
      schoolId: auth.schoolId,
      returnUrl: body.returnUrl,
      tenantContext: {
        schoolId: auth.schoolId,
        userId: auth.userId,
        requestId: c.get("requestId"),
      },
    });
    return c.json({ url: session.url }, 200);
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

export function serializeBilling(billing: StorageBillingDetails) {
  return {
    paymentMethod: billing.paymentMethod,
    nextBill: billing.nextBill
      ? { ...billing.nextBill, at: billing.nextBill.at.toISOString() }
      : null,
    invoices: billing.invoices.map((invoice) => ({
      ...invoice,
      created: invoice.created.toISOString(),
    })),
  };
}
