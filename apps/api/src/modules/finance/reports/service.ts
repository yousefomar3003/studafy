import { ERROR_CODES } from "@studafy/constants";
import {
  formattedCurrencyRows,
  generateJoInvoice,
  JoInvoiceValidationError,
  normalizeErpNextReport,
  type ErpNextReportResult,
  type FinanceFileFormat,
  type FinanceReportType,
  type GeneratedJoInvoice,
  type JoInvoiceInput,
} from "@studafy/finance-reporting";

import { CodedHttpException } from "../../../coded-http-exception";
import { translateErpNextError } from "../erpnext-errors";

import type { SupportedLocale } from "../../../middleware/locale";
import type { TenantErpNext } from "../client/tenant-client";
import type { TransactionSql } from "postgres";

export const ERP_REPORT_NAMES = {
  arAging: "Accounts Receivable Summary",
  generalLedger: "General Ledger",
  collections: "Accounts Receivable",
} as const;

export interface FinanceReportEnvelope {
  report_name: string;
  columns: unknown[];
  rows: unknown[];
  report_summary: unknown[];
  presentation: {
    locale: SupportedLocale;
    direction: "ltr" | "rtl";
    currency: "JOD";
    currency_precision: 3;
    currency_display: Record<string, string>[];
  };
}

export interface FinanceReportJobRow {
  id: string;
  report_type: FinanceReportType;
  file_format: FinanceFileFormat;
  status: "queued" | "processing" | "completed" | "failed";
  parameters: Record<string, unknown>;
  object_key: string | null;
  signed_url: string | null;
  signed_url_expires_at: Date | null;
  failure_message: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

async function companyId(tx: TransactionSql, schoolId: string): Promise<string> {
  const [row] = await tx<{ erpnext_company_id: string | null }[]>`
    SELECT erpnext_company_id
    FROM app.erpnext_site_configs
    WHERE school_id = ${schoolId}::uuid
  `;
  if (!row?.erpnext_company_id) {
    throw new CodedHttpException(
      503,
      ERROR_CODES.ERPNEXT_NOT_CONFIGURED,
      "ERPNext company is not configured for this school",
    );
  }
  return row.erpnext_company_id;
}

export function parseStudentIds(value: string | undefined): string[] {
  if (!value) return [];
  const values = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (
    values.some(
      (id) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
    )
  ) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "student_ids must contain UUIDs",
    );
  }
  return values;
}

export async function resolveCustomerIds(
  tx: TransactionSql,
  schoolId: string,
  studentIds: string[],
): Promise<string[]> {
  if (studentIds.length === 0) return [];
  const rows = await tx<{ id: string; admission_number: string }[]>`
    SELECT student.id, student.admission_number
    FROM app.students AS student
    WHERE student.school_id = ${schoolId}::uuid
      AND student.id = ANY(${studentIds}::uuid[])
  `;
  if (rows.length !== studentIds.length) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.RESOURCE_NOT_FOUND,
      "One or more students were not found",
    );
  }
  return rows.map((row) => row.admission_number);
}

export async function runFinanceReport(
  client: TenantErpNext,
  reportName: string,
  filters: Record<string, unknown>,
  locale: SupportedLocale,
  acceptLanguage: string | undefined,
): Promise<FinanceReportEnvelope> {
  try {
    const response = await client.post<unknown>(
      "/api/method/frappe.desk.query_report.run",
      { report_name: reportName, filters, ignore_prepared_report: 1 },
      { locale, ...(acceptLanguage ? { acceptLanguage } : {}) },
    );
    return reportEnvelope(reportName, normalizeErpNextReport(response.data), locale);
  } catch (error) {
    return translateErpNextError(error);
  }
}

export function reportEnvelope(
  reportName: string,
  report: ErpNextReportResult,
  locale: SupportedLocale,
): FinanceReportEnvelope {
  return {
    report_name: reportName,
    columns: report.columns,
    rows: report.rows,
    report_summary: report.reportSummary,
    presentation: {
      locale,
      direction: locale === "ar" ? "rtl" : "ltr",
      currency: "JOD",
      currency_precision: 3,
      currency_display: formattedCurrencyRows(report.columns, report.rows),
    },
  };
}

export async function buildFilters(
  tx: TransactionSql,
  schoolId: string,
  extra: Record<string, unknown>,
  studentIds: string[] = [],
): Promise<Record<string, unknown>> {
  const company = await companyId(tx, schoolId);
  const customers = await resolveCustomerIds(tx, schoolId, studentIds);
  return {
    ...extra,
    company,
    ...(customers.length > 0 ? { party_type: "Customer", party: customers } : {}),
  };
}

export async function familyCustomers(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
  requestingUserId: string,
  allowAll: boolean,
): Promise<{ studentIds: string[]; customerIds: string[] }> {
  const [family] = await tx<{ id: string }[]>`
    SELECT family.id
    FROM app.families AS family
    WHERE family.school_id = ${schoolId}::uuid
      AND family.id = ${familyId}::uuid
      AND (
        ${allowAll}
        OR family.primary_parent_user_id = ${requestingUserId}::uuid
        OR EXISTS (
          SELECT 1 FROM app.parent_child_links AS link
          WHERE link.school_id = family.school_id
            AND link.family_id = family.id
            AND link.parent_user_id = ${requestingUserId}::uuid
        )
      )
  `;
  if (!family) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Family not found");
  }
  const rows = await tx<{ student_id: string }[]>`
    SELECT DISTINCT student_id
    FROM app.parent_child_links
    WHERE school_id = ${schoolId}::uuid AND family_id = ${familyId}::uuid
    ORDER BY student_id
  `;
  const studentIds = rows.map((row) => row.student_id);
  return { studentIds, customerIds: await resolveCustomerIds(tx, schoolId, studentIds) };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function joInvoiceInput(schoolId: string, invoice: Record<string, unknown>): JoInvoiceInput {
  const rawItems = Array.isArray(invoice.items) ? invoice.items : [];
  return {
    schoolId,
    invoiceId: text(invoice.name),
    issueDate: text(invoice.posting_date),
    currency: text(invoice.currency),
    supplier: {
      name: text(invoice.company),
      taxId: text(invoice.company_tax_id),
      address: text(invoice.company_address_display),
    },
    customer: {
      name: text(invoice.customer_name ?? invoice.customer),
      taxId: text(invoice.tax_id),
      address: text(invoice.address_display ?? invoice.customer_address),
    },
    lines: rawItems.map((raw, index) => {
      const item = raw as Record<string, unknown>;
      return {
        id: text(item.idx) || String(index + 1),
        description: text(item.description ?? item.item_name),
        quantity: numberValue(item.qty),
        unitPrice: numberValue(item.rate),
        lineExtensionAmount: numberValue(item.net_amount ?? item.amount),
      };
    }),
    taxAmount: numberValue(invoice.total_taxes_and_charges),
    taxExclusiveAmount: numberValue(invoice.net_total),
    taxInclusiveAmount: numberValue(invoice.grand_total),
    payableAmount: numberValue(invoice.rounded_total ?? invoice.grand_total),
  };
}

export async function generateInvoiceArtifact(
  tx: TransactionSql,
  client: TenantErpNext,
  schoolId: string,
  invoiceId: string,
  locale: SupportedLocale,
  acceptLanguage: string | undefined,
): Promise<GeneratedJoInvoice> {
  let invoice: Record<string, unknown>;
  try {
    const response = await client.get<{ data?: Record<string, unknown> }>(
      `/api/resource/Sales%20Invoice/${encodeURIComponent(invoiceId)}`,
      { locale, ...(acceptLanguage ? { acceptLanguage } : {}) },
    );
    invoice = response.data.data ?? (response.data as Record<string, unknown>);
  } catch (error) {
    return translateErpNextError(error, {
      notFound: {
        code: ERROR_CODES.JOINVOICE_INVOICE_NOT_FOUND,
        message: "ERPNext invoice not found",
      },
    });
  }

  let artifact: GeneratedJoInvoice;
  try {
    artifact = generateJoInvoice(joInvoiceInput(schoolId, invoice));
  } catch (error) {
    if (error instanceof JoInvoiceValidationError) {
      throw new CodedHttpException(422, ERROR_CODES.JOINVOICE_INVALID_INVOICE, error.message);
    }
    throw error;
  }

  await tx`
    INSERT INTO app.joinvoice_export_logs (
      school_id, erpnext_invoice_id, joinvoice_uuid, canonical_sha256, submission_status
    )
    VALUES (
      ${schoolId}::uuid, ${invoiceId}, ${artifact.uuid}::uuid, ${artifact.hash}, 'generated'
    )
    ON CONFLICT (school_id, erpnext_invoice_id) DO NOTHING
  `;
  const [stored] = await tx<{ canonical_sha256: string; joinvoice_uuid: string }[]>`
    SELECT canonical_sha256, joinvoice_uuid
    FROM app.joinvoice_export_logs
    WHERE school_id = ${schoolId}::uuid AND erpnext_invoice_id = ${invoiceId}
  `;
  if (
    !stored ||
    stored.canonical_sha256 !== artifact.hash ||
    stored.joinvoice_uuid !== artifact.uuid
  ) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.JOINVOICE_INVOICE_CHANGED,
      "Invoice content changed after JoInvoice generation",
    );
  }
  return artifact;
}

export async function createFinanceReportJob(
  tx: TransactionSql,
  schoolId: string,
  requestedByUserId: string,
  reportType: FinanceReportType,
  fileFormat: FinanceFileFormat,
  parameters: Record<string, unknown>,
): Promise<FinanceReportJobRow> {
  const [row] = await tx<FinanceReportJobRow[]>`
    INSERT INTO app.finance_report_jobs (
      school_id, requested_by_user_id, report_type, file_format, parameters
    )
    VALUES (
      ${schoolId}::uuid, ${requestedByUserId}::uuid, ${reportType},
      ${fileFormat}, ${tx.json(parameters as never)}
    )
    RETURNING *
  `;
  return row!;
}

export async function failFinanceReportJob(
  tx: TransactionSql,
  schoolId: string,
  jobId: string,
): Promise<void> {
  await tx`
    UPDATE app.finance_report_jobs
    SET status = 'failed', failure_message = 'Export generation failed',
        completed_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE school_id = ${schoolId}::uuid AND id = ${jobId}::uuid
  `;
}

export async function getFinanceReportJob(
  tx: TransactionSql,
  schoolId: string,
  requestedByUserId: string,
  jobId: string,
): Promise<FinanceReportJobRow | null> {
  const [row] = await tx<FinanceReportJobRow[]>`
    SELECT *
    FROM app.finance_report_jobs
    WHERE school_id = ${schoolId}::uuid
      AND requested_by_user_id = ${requestedByUserId}::uuid
      AND id = ${jobId}::uuid
  `;
  return row ?? null;
}

export async function persistSignedUrl(
  tx: TransactionSql,
  schoolId: string,
  jobId: string,
  url: string,
  expiresAt: Date,
): Promise<void> {
  await tx`
    UPDATE app.finance_report_jobs
    SET signed_url = ${url}, signed_url_expires_at = ${expiresAt},
        updated_at = clock_timestamp()
    WHERE school_id = ${schoolId}::uuid AND id = ${jobId}::uuid
  `;
}
