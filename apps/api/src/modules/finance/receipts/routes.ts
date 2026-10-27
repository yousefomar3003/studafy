import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS, ROLES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { requireAuth } from "../../../middleware/authContext";
import { hasPermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import { paymentIdParamSchema } from "../payments/schemas";
import { withStudentIdentityTx } from "../students/service";

import { renderReceiptPdf } from "./render";
import { loadReceipt } from "./service";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";

const receiptRoute = createRoute({
  method: "get",
  path: "/api/finance/payments/{paymentId}/receipt",
  tags: ["Finance"],
  operationId: "getPaymentReceipt",
  summary: "Download a payment receipt",
  description:
    "The payment's receipt as a PDF, in the caller's language (Accept-Language), rendered from the " +
    "finance cache. Finance staff (`billing:viewInvoices`) can download any receipt; a guardian only " +
    "their own children's. Any other caller gets 404, as for a payment that does not exist. " +
    "`paymentId` is the Studafy id or the ERPNext Payment Entry name.",
  security: [{ bearerAuth: [] }],
  request: { params: paymentIdParamSchema },
  responses: {
    ...standardResponses({}, [401, 403, 404, 500]),
    200: {
      description: "The receipt.",
      headers: requestIdHeaders,
      content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } },
    },
  },
});

export function receiptRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.openapi(receiptRoute, async (c) => {
    const auth = requireAuth(c);
    const allowAll = hasPermission(auth.roles, PERMISSIONS.BILLING_VIEW_INVOICES);
    if (!allowAll && !auth.roles.includes(ROLES.PARENT)) {
      throw new CodedHttpException(
        403,
        ERROR_CODES.AUTHZ_FORBIDDEN,
        "Not allowed to view receipts",
      );
    }
    const { paymentId } = c.req.valid("param");
    const locale = (c.get("locale") ?? "en") as SupportedLocale;
    const input = await withStudentIdentityTx(database, auth.schoolId, (tx) =>
      loadReceipt(tx, auth.schoolId, paymentId, { userId: auth.userId, allowAll }, locale),
    );
    const pdf = await renderReceiptPdf(input);
    const filename = `receipt-${input.receiptNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
    c.header("Content-Disposition", `inline; filename="${filename}"`);
    c.header("Cache-Control", "private, no-store");
    return c.body(new Uint8Array(pdf), 200, { "Content-Type": "application/pdf" });
  });

  return routes;
}
