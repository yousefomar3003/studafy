import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { listSchoolInvoices } from "../services/invoice-service";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";
import type { PaymentProviderPort } from "../ports/payment-provider";

function requireProvider(provider: PaymentProviderPort | null): PaymentProviderPort {
  if (!provider) {
    throw new CodedHttpException(
      503,
      ERROR_CODES.STRIPE_NOT_CONFIGURED,
      "Stripe billing is not configured for this deployment",
    );
  }
  return provider;
}

const InvoiceSchema = z.object({
  id: z.string(),
  status: z.string().nullable(),
  amountDue: z.number(),
  amountPaid: z.number(),
  currency: z.string(),
  created: z.string().datetime(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  hostedInvoiceUrl: z.string().nullable(),
  invoicePdf: z.string().nullable(),
});

const InvoiceListResponseSchema = z
  .object({
    invoices: z.array(InvoiceSchema),
    hasMore: z.boolean(),
  })
  .openapi("BillingInvoiceList");

const listInvoicesRoute = createRoute({
  method: "get",
  path: "/api/subscriptions/current/invoices",
  tags: ["Subscriptions"],
  operationId: "listBillingInvoices",
  summary: "List the school's invoices",
  description:
    "Reads invoices directly from the payment provider -- Studafy keeps no local copy of its own " +
    "plan invoices. Admin-only, web-origin only.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      startingAfter: z.string().optional(),
    }),
  },
  responses: standardResponses(
    { 200: { description: "Invoice page.", schema: InvoiceListResponseSchema } },
    [401, 403, 404, 429, 500, 503],
  ),
});

export function invoiceRoutes(
  database: Database,
  provider: PaymentProviderPort | null,
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  const basePath = "/api/subscriptions/current/invoices";

  app.use(basePath, requireChannel(AUTH_CHANNELS.WEB));
  app.use(basePath, requirePermission(PERMISSIONS.ORGANIZATION_MANAGE_BILLING));

  app.openapi(listInvoicesRoute, async (c) => {
    const active = requireProvider(provider);
    const auth = requireAuth(c);
    const requestId = c.get("requestId");
    const { limit, startingAfter } = c.req.valid("query");

    const result = await listSchoolInvoices(database, active, {
      schoolId: auth.schoolId,
      limit,
      startingAfter,
      tenantContext: { schoolId: auth.schoolId, userId: auth.userId, requestId },
    });

    return c.json(
      {
        invoices: result.invoices.map((invoice) => ({
          ...invoice,
          created: invoice.created.toISOString(),
          periodStart: invoice.periodStart.toISOString(),
          periodEnd: invoice.periodEnd.toISOString(),
        })),
        hasMore: result.hasMore,
      },
      200,
    );
  });

  return app;
}
