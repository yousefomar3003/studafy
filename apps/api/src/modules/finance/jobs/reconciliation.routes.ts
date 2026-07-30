import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

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
    "detects fee_schedule_cache drift against ERPNext AR/GL, auto-heals by re-pulling " +
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

  routes.openapi(runReconciliationRoute, async (c) => {
    const apiKey = c.req.header("X-Api-Key");
    const expectedKey = process.env.RECONCILIATION_API_KEY;

    if (!apiKey || !expectedKey || apiKey !== expectedKey) {
      return c.json(
        {
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          code: "ACCESS_DENIED",
          request_id: c.get("requestId") ?? "",
        },
        403,
      );
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
