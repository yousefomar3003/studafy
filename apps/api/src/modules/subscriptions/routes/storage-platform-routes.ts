import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS, STORAGE_ADDON_PLAN_CODES } from "@studafy/constants";
import { z } from "zod";

import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import {
  getPlatformStorageSubscription,
  refundPlatformStorageInvoice,
} from "../services/storage-platform-service";

import { StorageInvoiceSchema } from "./storage-addon-routes";

import type { Database } from "../../../db";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { LicenseActor } from "../../licensing/context";
import type { PaymentProviderRegistry } from "../payment-provider-routing";
import type { Context } from "hono";

const TAG = "Platform";

const schoolParams = z.object({ schoolId: z.string().uuid() });
const invoiceParams = z.object({
  schoolId: z.string().uuid(),
  invoiceId: z.string().min(1).max(255),
});

const priceSchema = z.object({
  id: z.string().uuid(),
  amountMinor: z.number().int(),
  currency: z.string(),
  interval: z.enum(["monthly", "yearly"]),
});
const planCodeSchema = z.enum(STORAGE_ADDON_PLAN_CODES as [string, ...string[]]);

const PlatformStorageSchema = z
  .object({
    subscription: z
      .object({
        planCode: planCodeSchema.nullable(),
        capBytes: z.number().int(),
        status: z.string(),
        price: priceSchema.nullable(),
        currentPeriodEnd: z.string().datetime(),
        cancelAtPeriodEnd: z.boolean(),
        stripeSubscriptionId: z.string().nullable(),
        pendingChange: z
          .object({
            planCode: planCodeSchema.nullable(),
            capBytes: z.number().int(),
            price: priceSchema.nullable(),
            effectiveAt: z.string().datetime(),
          })
          .nullable(),
      })
      .nullable(),
    billing: z
      .object({
        paymentMethod: z
          .object({
            brand: z.string(),
            last4: z.string().nullable(),
            expMonth: z.number().int().nullable(),
            expYear: z.number().int().nullable(),
          })
          .nullable(),
        nextBill: z
          .object({
            amountMinor: z.number().int(),
            currency: z.string(),
            at: z.string().datetime(),
          })
          .nullable(),
        invoices: z.array(StorageInvoiceSchema),
      })
      .nullable(),
    billingError: z.string().nullable(),
    incidents: z.array(
      z.object({
        id: z.string().uuid(),
        stripeInvoiceId: z.string(),
        expectedMinor: z.number().int(),
        chargedMinor: z.number().int(),
        refundMinor: z.number().int(),
        currency: z.string(),
        stripeRefundId: z.string().nullable(),
        status: z.enum(["refunded", "needs_review"]),
        lastError: z.string().nullable(),
        createdAt: z.string().datetime(),
      }),
    ),
  })
  .openapi("PlatformStorageSubscription");

const RefundBodySchema = z.object({
  amountMinor: z.number().int().min(1),
  reason: z.string().trim().min(3).max(500),
  requestKey: z.string().uuid().openapi({
    description: "One per confirmation: repeating it never refunds twice.",
  }),
});

const RefundResultSchema = z
  .object({
    refundId: z.string(),
    status: z.enum(["succeeded", "pending"]),
    amountMinor: z.number().int(),
  })
  .openapi("PlatformStorageRefund");

const getRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/storage-subscription",
  tags: [TAG],
  operationId: "getPlatformSchoolStorageSubscription",
  summary: "A school's storage add-on, its invoices and billing incidents",
  description:
    "The add-on with any change scheduled for its renewal, its Stripe invoices (what each took and " +
    "what was refunded) and the overcharges refunded automatically. platform:read; web only.",
  security: [{ bearerAuth: [] }],
  request: { params: schoolParams },
  responses: standardResponses(
    { 200: { description: "The storage add-on", schema: PlatformStorageSchema } },
    [401, 403, 429, 500],
  ),
});

const refundRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/storage-subscription/invoices/{invoiceId}/refund",
  tags: [TAG],
  operationId: "refundPlatformSchoolStorageInvoice",
  summary: "Refund a school's storage invoice",
  description:
    "Fully or in part, with a reason; audited. The amount may not exceed what the invoice took less " +
    "what was already refunded (422 STORAGE_ADDON_REFUND_INVALID). platform:manage; web only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: invoiceParams,
    body: { content: { "application/json": { schema: RefundBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The refund", schema: RefundResultSchema } },
    [400, 401, 403, 422, 429, 500, 502],
  ),
});

function actorFrom(c: Context<AppEnv>): LicenseActor {
  const auth = requireAuth(c);
  return {
    kind: "platform",
    userId: auth.userId,
    homeSchoolId: auth.schoolId,
    requestId: c.get("requestId"),
    locale: (c.get("locale") ?? "en") as SupportedLocale,
  };
}

const iso = (date: Date) => date.toISOString();

/** The storage add-on in the platform console: read with platform:read, refund with platform:manage. */
export function platformStorageRoutes(
  database: Database,
  providers: PaymentProviderRegistry,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);

  for (const path of [
    "/api/platform/schools/:schoolId/storage-subscription",
    "/api/platform/schools/:schoolId/storage-subscription/*",
  ]) {
    routes.use(path, requireChannel(AUTH_CHANNELS.WEB));
    routes.use(path, requirePermission(PERMISSIONS.PLATFORM_READ));
    routes.use(path, (c, next) => (c.req.method === "GET" ? next() : manage(c, next)));
  }
  routes.use(
    "/api/platform/schools/:schoolId/storage-subscription/invoices/:invoiceId/refund",
    auditAction("update", "storage_subscriptions"),
  );

  routes.openapi(getRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const result = await getPlatformStorageSubscription(
      database,
      providers,
      schoolId,
      actorFrom(c),
    );
    const sub = result.subscription;
    return c.json(
      {
        subscription: sub
          ? {
              ...sub,
              currentPeriodEnd: iso(sub.currentPeriodEnd),
              pendingChange: sub.pendingChange
                ? { ...sub.pendingChange, effectiveAt: iso(sub.pendingChange.effectiveAt) }
                : null,
            }
          : null,
        billing: result.billing
          ? {
              paymentMethod: result.billing.paymentMethod,
              nextBill: result.billing.nextBill
                ? { ...result.billing.nextBill, at: iso(result.billing.nextBill.at) }
                : null,
              invoices: result.billing.invoices.map((invoice) => ({
                ...invoice,
                created: iso(invoice.created),
              })),
            }
          : null,
        billingError: result.billingError,
        incidents: result.incidents.map((incident) => ({
          ...incident,
          createdAt: iso(incident.createdAt),
        })),
      },
      200,
    );
  });

  routes.openapi(refundRoute, async (c) => {
    const { schoolId, invoiceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await refundPlatformStorageInvoice(database, providers, {
      schoolId,
      invoiceId,
      amountMinor: body.amountMinor,
      reason: body.reason,
      requestKey: body.requestKey,
      actor: actorFrom(c),
    });
    return c.json(result, 200);
  });

  return routes;
}
