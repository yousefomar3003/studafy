import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ERROR_CODES, JOB_NAMES, PERMISSIONS, QUEUE_NAMES } from "@studafy/constants";
import { type FinanceExportJobData } from "@studafy/finance-reporting";
import { Queue } from "bullmq";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { requireStorage } from "../../../lib/storage";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { hasPermission, requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";

import {
  arAgingQuerySchema,
  collectionsQuerySchema,
  familyStatementParamSchema,
  familyStatementQuerySchema,
  familyStatementResponseSchema,
  financeExportBodySchema,
  financeExportJobParamSchema,
  financeExportJobResponseSchema,
  financeReportResponseSchema,
  generalLedgerQuerySchema,
  joinvoiceJsonResponseSchema,
  joinvoiceParamSchema,
  joinvoiceQuerySchema,
} from "./schemas";
import {
  buildFilters,
  createFinanceReportJob,
  ERP_REPORT_NAMES,
  failFinanceReportJob,
  familyCustomers,
  generateInvoiceArtifact,
  getFinanceReportJob,
  parseStudentIds,
  persistSignedUrl,
  resolveCustomerIds,
  runFinanceReport,
  type FinanceReportJobRow,
} from "./service";

import type { Database } from "../../../db/client";
import type { StorageService } from "../../../lib/storage";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { TenantErpNextFactory } from "../client/tenant-client";
import type { Context } from "hono";

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function toJobResponse(job: FinanceReportJobRow) {
  return {
    id: job.id,
    report_type: job.report_type,
    file_format: job.file_format,
    status: job.status,
    polling_url: `/api/finance/reports/export/${job.id}`,
    download_url: job.signed_url,
    download_url_expires_at: job.signed_url_expires_at?.toISOString() ?? null,
    failure_message: job.status === "failed" ? "Export generation failed" : null,
    created_at: job.created_at.toISOString(),
    started_at: job.started_at?.toISOString() ?? null,
    completed_at: job.completed_at?.toISOString() ?? null,
  };
}

const arAgingRoute = createRoute({
  method: "get",
  path: "/api/finance/reports/ar-aging",
  tags: ["Finance"],
  operationId: "getFinanceArAgingReport",
  security: [{ bearerAuth: [] }],
  request: { query: arAgingQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "ERPNext accounts receivable aging.",
        schema: financeReportResponseSchema,
      },
    },
    [400, 401, 403, 404, 429, 500, 503],
  ),
});

const generalLedgerRoute = createRoute({
  method: "get",
  path: "/api/finance/reports/general-ledger",
  tags: ["Finance"],
  operationId: "getFinanceGeneralLedgerReport",
  security: [{ bearerAuth: [] }],
  request: { query: generalLedgerQuerySchema },
  responses: standardResponses(
    { 200: { description: "ERPNext general ledger.", schema: financeReportResponseSchema } },
    [400, 401, 403, 404, 429, 500, 503],
  ),
});

const collectionsRoute = createRoute({
  method: "get",
  path: "/api/finance/reports/collections-vs-due",
  tags: ["Finance"],
  operationId: "getFinanceCollectionsVsDueReport",
  security: [{ bearerAuth: [] }],
  request: { query: collectionsQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "ERPNext receivables by payment terms.",
        schema: financeReportResponseSchema,
      },
    },
    [400, 401, 403, 404, 429, 500, 503],
  ),
});

const familyStatementRoute = createRoute({
  method: "get",
  path: "/api/finance/reports/family-statement/{familyId}",
  tags: ["Finance"],
  operationId: "getFinanceFamilyStatement",
  security: [{ bearerAuth: [] }],
  request: { params: familyStatementParamSchema, query: familyStatementQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "ERPNext-backed household statement.",
        schema: familyStatementResponseSchema,
      },
    },
    [400, 401, 403, 404, 429, 500, 503],
  ),
});

const joinvoiceRoute = createRoute({
  method: "get",
  path: "/api/finance/reports/joinvoice/{invoiceId}",
  tags: ["Finance"],
  operationId: "getJoInvoiceArtifact",
  security: [{ bearerAuth: [] }],
  request: { params: joinvoiceParamSchema, query: joinvoiceQuerySchema },
  responses: {
    ...standardResponses({}, [400, 401, 403, 404, 409, 422, 429, 500, 503]),
    200: {
      description: "Generated JoFotara UBL 2.1 artifact.",
      headers: requestIdHeaders,
      content: {
        "application/xml": { schema: z.string() },
        "application/json": { schema: joinvoiceJsonResponseSchema },
      },
    },
  },
});

const createExportRoute = createRoute({
  method: "post",
  path: "/api/finance/reports/export",
  tags: ["Finance"],
  operationId: "createFinanceReportExport",
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: financeExportBodySchema } } },
  },
  responses: standardResponses(
    { 202: { description: "Finance export queued.", schema: financeExportJobResponseSchema } },
    [400, 401, 403, 503, 500],
  ),
});

const getExportRoute = createRoute({
  method: "get",
  path: "/api/finance/reports/export/{jobId}",
  tags: ["Finance"],
  operationId: "getFinanceReportExport",
  security: [{ bearerAuth: [] }],
  request: { params: financeExportJobParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "Requester-owned export status.",
        schema: financeExportJobResponseSchema,
      },
    },
    [401, 403, 404, 503, 500],
  ),
});

export function financeReportRoutes(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
  redis: RedisClient | null,
  storage: StorageService | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const queue = redis ? new Queue(QUEUE_NAMES.REPORTS, { connection: redis as never }) : null;

  for (const path of [
    "/api/finance/reports/ar-aging",
    "/api/finance/reports/general-ledger",
    "/api/finance/reports/collections-vs-due",
  ]) {
    routes.use(path, requirePermission(PERMISSIONS.REPORT_VIEW_FINANCIAL));
  }
  routes.use(
    "/api/finance/reports/joinvoice/:invoiceId",
    requirePermission(PERMISSIONS.REPORT_VIEW_FINANCIAL),
  );
  routes.use(
    "/api/finance/reports/joinvoice/:invoiceId",
    requirePermission(PERMISSIONS.BILLING_VIEW_INVOICES),
  );
  routes.use("/api/finance/reports/export", requirePermission(PERMISSIONS.REPORT_EXPORT));
  routes.use("/api/finance/reports/export", requirePermission(PERMISSIONS.REPORT_VIEW_FINANCIAL));
  routes.use("/api/finance/reports/export/:jobId", requirePermission(PERMISSIONS.REPORT_EXPORT));
  routes.use("/api/finance/reports/export", auditAction("insert", "finance_report_jobs"));

  routes.openapi(arAgingRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");
    const locale = c.get("locale") as SupportedLocale;
    const report = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const filters = await buildFilters(
        tx,
        auth.schoolId,
        {
          report_date: query.report_date ?? today(),
          ageing_based_on: "Due Date",
          range1: 30,
          range2: 60,
          range3: 90,
        },
        parseStudentIds(query.student_ids),
      );
      const client = await erpnextFactory.forSchool(tx, auth.schoolId);
      return runFinanceReport(
        client,
        ERP_REPORT_NAMES.arAging,
        filters,
        locale,
        c.req.header("Accept-Language"),
      );
    });
    return c.json(report, 200);
  });

  routes.openapi(generalLedgerRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");
    const locale = c.get("locale") as SupportedLocale;
    const report = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const filters = await buildFilters(
        tx,
        auth.schoolId,
        {
          from_date: query.from_date,
          to_date: query.to_date,
          ...(query.account ? { account: query.account } : {}),
          ...(query.voucher_no ? { voucher_no: query.voucher_no } : {}),
          ...(query.voucher_type ? { voucher_type: query.voucher_type } : {}),
        },
        parseStudentIds(query.student_ids),
      );
      const client = await erpnextFactory.forSchool(tx, auth.schoolId);
      return runFinanceReport(
        client,
        ERP_REPORT_NAMES.generalLedger,
        filters,
        locale,
        c.req.header("Accept-Language"),
      );
    });
    return c.json(report, 200);
  });

  routes.openapi(collectionsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");
    const locale = c.get("locale") as SupportedLocale;
    const report = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const filters = await buildFilters(
        tx,
        auth.schoolId,
        {
          report_date: query.report_date ?? today(),
          based_on_payment_terms: 1,
          show_future_payments: 1,
        },
        parseStudentIds(query.student_ids),
      );
      const client = await erpnextFactory.forSchool(tx, auth.schoolId);
      return runFinanceReport(
        client,
        ERP_REPORT_NAMES.collections,
        filters,
        locale,
        c.req.header("Accept-Language"),
      );
    });
    return c.json(report, 200);
  });

  routes.openapi(familyStatementRoute, async (c) => {
    const auth = requireAuth(c);
    const { familyId } = c.req.valid("param");
    const query = c.req.valid("query");
    const locale = c.get("locale") as SupportedLocale;
    const canViewAll = hasPermission(auth.roles, PERMISSIONS.REPORT_VIEW_FINANCIAL);
    const result = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const family = await familyCustomers(tx, auth.schoolId, familyId, auth.userId, canViewAll);
      const companyFilters = await buildFilters(tx, auth.schoolId, {}, family.studentIds);
      const client = await erpnextFactory.forSchool(tx, auth.schoolId);
      const accountsReceivable = await runFinanceReport(
        client,
        ERP_REPORT_NAMES.arAging,
        {
          ...companyFilters,
          report_date: query.to_date ?? today(),
          ageing_based_on: "Due Date",
          range1: 30,
          range2: 60,
          range3: 90,
        },
        locale,
        c.req.header("Accept-Language"),
      );
      const generalLedger = await runFinanceReport(
        client,
        ERP_REPORT_NAMES.generalLedger,
        {
          ...companyFilters,
          from_date: query.from_date ?? "1900-01-01",
          to_date: query.to_date ?? today(),
        },
        locale,
        c.req.header("Accept-Language"),
      );
      return { family, accountsReceivable, generalLedger };
    });
    return c.json(
      {
        family_id: familyId,
        student_ids: result.family.studentIds,
        customer_ids: result.family.customerIds,
        accounts_receivable: result.accountsReceivable,
        general_ledger: result.generalLedger,
        household_totals: result.accountsReceivable.report_summary,
      },
      200,
    );
  });

  routes.openapi(joinvoiceRoute, async (c) => {
    const auth = requireAuth(c);
    const { invoiceId } = c.req.valid("param");
    const { format } = c.req.valid("query");
    const artifact = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const client = await erpnextFactory.forSchool(tx, auth.schoolId);
      return generateInvoiceArtifact(
        tx,
        client,
        auth.schoolId,
        invoiceId,
        c.get("locale") as SupportedLocale,
        c.req.header("Accept-Language"),
      );
    });
    const safeInvoiceId = invoiceId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
    if (format === "json") {
      c.header("Content-Disposition", `attachment; filename="${safeInvoiceId}.json"`);
      return c.json(artifact.jsonEnvelope, 200);
    }
    c.header("Content-Disposition", `attachment; filename="${safeInvoiceId}.xml"`);
    return c.body(artifact.xml, 200, { "Content-Type": "application/xml; charset=utf-8" });
  });

  routes.openapi(createExportRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    if (!queue || !storage) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.FINANCE_REPORT_EXPORT_UNAVAILABLE,
        "Finance report queue or object storage is not configured",
      );
    }
    const job = await withTenantTx(database, tenantFrom(c), async (tx) => {
      let parameters: Record<string, unknown>;
      switch (body.report_type) {
        case "ar_aging":
        case "collections_vs_due": {
          const customers = await resolveCustomerIds(
            tx,
            auth.schoolId,
            body.parameters.student_ids ?? [],
          );
          parameters = {
            report_date: body.parameters.report_date ?? today(),
            ...(customers.length > 0 ? { party_type: "Customer", party: customers } : {}),
          };
          break;
        }
        case "general_ledger": {
          const customers = await resolveCustomerIds(
            tx,
            auth.schoolId,
            body.parameters.student_ids ?? [],
          );
          parameters = {
            from_date: body.parameters.from_date,
            to_date: body.parameters.to_date,
            ...(body.parameters.account ? { account: body.parameters.account } : {}),
            ...(body.parameters.voucher_no ? { voucher_no: body.parameters.voucher_no } : {}),
            ...(body.parameters.voucher_type ? { voucher_type: body.parameters.voucher_type } : {}),
            ...(customers.length > 0 ? { party_type: "Customer", party: customers } : {}),
          };
          break;
        }
        case "family_statement": {
          const family = await familyCustomers(
            tx,
            auth.schoolId,
            body.parameters.family_id,
            auth.userId,
            true,
          );
          parameters = {
            family_id: body.parameters.family_id,
            from_date: body.parameters.from_date ?? "1900-01-01",
            to_date: body.parameters.to_date ?? today(),
            party_type: "Customer",
            party: family.customerIds,
          };
          break;
        }
        case "joinvoice_export":
          parameters = { invoice_id: body.parameters.invoice_id };
          break;
      }
      return createFinanceReportJob(
        tx,
        auth.schoolId,
        auth.userId,
        body.report_type,
        body.file_format,
        parameters,
      );
    });
    const payload: FinanceExportJobData = {
      version: 1,
      jobId: job.id,
      schoolId: auth.schoolId,
      requestedByUserId: auth.userId,
    };
    try {
      await queue.add(JOB_NAMES.GENERATE_FINANCE_REPORT, payload, {
        jobId: job.id,
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      });
    } catch {
      await withTenantTx(database, tenantFrom(c), (tx) =>
        failFinanceReportJob(tx, auth.schoolId, job.id),
      );
      throw new CodedHttpException(
        503,
        ERROR_CODES.FINANCE_REPORT_EXPORT_UNAVAILABLE,
        "Finance report could not be queued",
      );
    }
    return c.json(toJobResponse(job), 202);
  });

  routes.openapi(getExportRoute, async (c) => {
    const auth = requireAuth(c);
    const { jobId } = c.req.valid("param");
    const job = await withTenantTx(database, tenantFrom(c), (tx) =>
      getFinanceReportJob(tx, auth.schoolId, auth.userId, jobId),
    );
    if (!job) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.FINANCE_REPORT_NOT_FOUND,
        "Finance report export not found",
      );
    }
    if (
      job.status === "completed" &&
      job.object_key &&
      (!job.signed_url_expires_at || job.signed_url_expires_at.getTime() <= Date.now() + 5 * 60_000)
    ) {
      const signed = await requireStorage(storage).presign(
        job.object_key,
        "GET",
        undefined,
        86_400,
      );
      job.signed_url = signed.url;
      job.signed_url_expires_at = signed.expiresAt;
      await withTenantTx(database, tenantFrom(c), (tx) =>
        persistSignedUrl(tx, auth.schoolId, job.id, signed.url, signed.expiresAt),
      );
    }
    return c.json(toJobResponse(job), 200);
  });

  return routes;
}
