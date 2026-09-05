import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { auditAction } from "../../../middleware/auditEmitter";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import { runGlobalReconciliation } from "./reconciliation.job";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { TenantErpNextFactory } from "../client/tenant-client";

const reconciliationResultSchema = z
  .object({
    schools_processed: z.number().int(),
    total_drift_detected: z.number().int(),
    total_auto_healed: z.number().int(),
    total_unresolved: z.number().int(),
    job_run_at: z.string().datetime(),
  })
  .openapi("ReconciliationResult");

const runReconciliationRoute = createRoute({
  method: "post",
  path: "/api/finance/reconciliation/run",
  tags: ["Finance"],
  operationId: "runReconciliation",
  summary: "Run daily finance reconciliation across all schools",
  description:
    "Triggers the daily reconciliation job for every school. Flags overdue installments, " +
    "detects installment_cache drift against ERPNext AR/GL, auto-heals by re-pulling " +
    "authoritative DocType snapshots, and logs unresolved divergences for alerting.\n\n" +
    "Authenticated via an internal service API key (X-Api-Key header), not a user bearer token.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    {
      200: {
        description: "Reconciliation complete.",
        schema: reconciliationResultSchema,
      },
    },
    [401, 403, 500],
  ),
});

export function reconciliationRoutes(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
  logger: Logger,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(
    "/api/finance/reconciliation/run",
    auditAction("insert", "finance_reconciliation_logs"),
  );

  routes.openapi(runReconciliationRoute, async (c) => {
    const apiKey = c.req.header("X-Api-Key");
    const expectedKey = process.env.RECONCILIATION_API_KEY;

    if (!apiKey || !expectedKey || apiKey !== expectedKey) {
      // ST-249: was a hand-rolled `c.json(..., 403)` that skipped errorHandlerMiddleware entirely,
      // so it carried `Content-Type: application/json` instead of the RFC 9457
      // `application/problem+json` every other error response in the app uses, and no request_id
      // correlation. Throwing here, like every other denial in the app, restores both.
      throw new CodedHttpException(403, ERROR_CODES.ACCESS_DENIED, "Access denied");
    }

    const result = await runGlobalReconciliation(database, erpnextFactory, logger);

    return c.json(
      {
        schools_processed: result.schoolsProcessed,
        total_drift_detected: result.totalDriftDetected,
        total_auto_healed: result.totalAutoHealed,
        total_unresolved: result.totalUnresolved,
        job_run_at: result.jobRunAt,
      },
      200,
    );
  });

  return routes;
}
