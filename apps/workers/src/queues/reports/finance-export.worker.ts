/**
 * Finance export report type (ST-175).
 *
 * After the async report framework landed, this file is the finance half of a registry entry: the
 * deterministic object key (tenant/`<schoolId>`/`reports`/`<year>`/`<jobId>.<format>`), the
 * renderer (ERPNext query reports or JoInvoice generation, both under a `withSystemTenantTx`), the
 * content headers, and the shared PDF renderer. The lifecycle SQL that used to live here moved to
 * `finance-report-store.ts`, and `processFinanceExport` was replaced by the generic runner in
 * `report-runner.ts`.
 */

import notoSansArabic from "@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff" with { type: "file" };
import * as fontkit from "@pdf-lib/fontkit";
import {
  generateJoInvoice,
  normalizeErpNextReport,
  reportToCsv,
  type ErpNextReportResult,
  type FinanceExportJobData,
  type FinanceFileFormat,
  type FinanceReportType,
  type JoInvoiceInput,
} from "@studafy/finance-reporting";
import bidiFactory from "bidi-js";
import { PDFDocument, rgb } from "pdf-lib";

import { withSystemTenantTx } from "../../db/tenant-tx";
import { resolveSchoolCredentials } from "../billing/credential-resolver";
import { ErpNextClient } from "../billing/erpnext-client";

import type { FinanceReportJobRow } from "./finance-report-store";
import type { ReportRenderDeps } from "./report-types";
import type { TransactionSql } from "postgres";

export function financeReportStorageKey(
  data: FinanceExportJobData,
  format: FinanceFileFormat,
  now = new Date(),
): string {
  return `tenant-${data.schoolId}/reports/${now.getUTCFullYear()}/${data.jobId}.${format}`;
}

function reportName(reportType: FinanceReportType): string {
  switch (reportType) {
    case "ar_aging":
    case "family_statement":
      return "Accounts Receivable Summary";
    case "general_ledger":
      return "General Ledger";
    case "collections_vs_due":
      return "Accounts Receivable";
    case "joinvoice_export":
      throw new Error("JoInvoice export does not use a query report");
  }
}

export function financeContentType(format: FinanceFileFormat): string {
  switch (format) {
    case "csv":
      return "text/csv; charset=utf-8";
    case "pdf":
      return "application/pdf";
    case "xml":
      return "application/xml; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
  }
}

export function financeContentDisposition(
  data: FinanceExportJobData,
  format: FinanceFileFormat,
): string {
  return `attachment; filename="${data.jobId}.${format}"`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function invoiceInput(schoolId: string, invoice: Record<string, unknown>): JoInvoiceInput {
  return {
    schoolId,
    invoiceId: stringValue(invoice.name),
    issueDate: stringValue(invoice.posting_date),
    currency: stringValue(invoice.currency),
    supplier: {
      name: stringValue(invoice.company),
      taxId: stringValue(invoice.company_tax_id),
      address: stringValue(invoice.company_address_display),
    },
    customer: {
      name: stringValue(invoice.customer_name ?? invoice.customer),
      taxId: stringValue(invoice.tax_id),
      address: stringValue(invoice.address_display ?? invoice.customer_address),
    },
    lines: (Array.isArray(invoice.items) ? invoice.items : []).map((raw, index) => {
      const item = raw as Record<string, unknown>;
      return {
        id: stringValue(item.idx) || String(index + 1),
        description: stringValue(item.description ?? item.item_name),
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

function reportFilters(
  reportType: FinanceReportType,
  company: string,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const callerParameters = { ...parameters };
  delete callerParameters.company;
  delete callerParameters.report_name;
  if (reportType === "ar_aging" || reportType === "family_statement") {
    delete callerParameters.family_id;
    delete callerParameters.from_date;
    const statementDate = callerParameters.to_date;
    delete callerParameters.to_date;
    return {
      ...callerParameters,
      company,
      ...(reportType === "family_statement" ? { report_date: statementDate } : {}),
      ageing_based_on: "Due Date",
      range1: 30,
      range2: 60,
      range3: 90,
    };
  }
  if (reportType === "collections_vs_due") {
    return {
      ...callerParameters,
      company,
      based_on_payment_terms: 1,
      show_future_payments: 1,
    };
  }
  return { ...callerParameters, company };
}

const bidi = bidiFactory();
const ARABIC_PATTERN = /[\u0600-\u06ff]/;

function visualPdfText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!ARABIC_PATTERN.test(text)) return text;
  const characters = [...text];
  const levels = bidi.getEmbeddingLevels(text, "rtl");
  for (const [start, end] of bidi.getReorderSegments(text, levels)) {
    const reversed = characters.slice(start, end + 1).reverse();
    characters.splice(start, reversed.length, ...reversed);
  }
  for (const [index, replacement] of bidi.getMirroredCharactersMap(text, levels)) {
    characters[index] = replacement;
  }
  return characters.join("");
}

export async function reportsToPdf(
  reports: { title: string; report: ErpNextReportResult }[],
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  document.setTitle("Studafy Finance Report");
  document.setSubject(
    "JOD, three-decimal finance report; Noto Sans Arabic with Unicode bidi layout",
  );
  const fontBytes = await Bun.file(notoSansArabic).arrayBuffer();
  const font = await document.embedFont(fontBytes, { subset: true });
  const pageSize: [number, number] = [842, 595];
  let page = document.addPage(pageSize);
  let y = page.getHeight() - 36;
  const draw = (value: unknown, isBold = false) => {
    if (y < 36) {
      page = document.addPage(pageSize);
      y = page.getHeight() - 36;
    }
    const source = typeof value === "string" ? value : JSON.stringify(value);
    const rendered = visualPdfText(source.slice(0, 150));
    const rtl = ARABIC_PATTERN.test(source);
    page.drawText(rendered, {
      x: rtl ? Math.max(36, page.getWidth() - 36 - font.widthOfTextAtSize(rendered, 8)) : 36,
      y,
      size: isBold ? 9 : 8,
      font,
      color: rgb(0.08, 0.12, 0.18),
    });
    y -= 12;
  };
  for (const { title, report } of reports) {
    draw(title, true);
    draw(report.columns.map((column) => column.label ?? column.fieldname).join(" | "), true);
    for (const row of report.rows) {
      draw(Array.isArray(row) ? row.join(" | ") : row);
    }
    y -= 8;
  }
  return document.save();
}

async function fetchReport(
  client: ErpNextClient,
  name: string,
  filters: Record<string, unknown>,
): Promise<ErpNextReportResult> {
  const response = await client.post<unknown>("/api/method/frappe.desk.query_report.run", {
    report_name: name,
    filters,
    ignore_prepared_report: 1,
  });
  return normalizeErpNextReport(response.data);
}

async function generateReportArtifact(
  client: ErpNextClient,
  row: FinanceReportJobRow,
  company: string,
): Promise<Uint8Array> {
  if (row.report_type === "family_statement") {
    const receivables = await fetchReport(
      client,
      "Accounts Receivable Summary",
      reportFilters("family_statement", company, row.parameters),
    );
    const ledgerParameters = { ...row.parameters };
    delete ledgerParameters.family_id;
    const ledger = await fetchReport(client, "General Ledger", {
      ...ledgerParameters,
      company,
    });
    if (row.file_format === "pdf") {
      return reportsToPdf([
        { title: "Accounts Receivable Summary", report: receivables },
        { title: "General Ledger", report: ledger },
      ]);
    }
    const receivablesCsv = new TextDecoder()
      .decode(reportToCsv(receivables))
      .replace(/^\uFEFF/, "");
    const ledgerCsv = new TextDecoder().decode(reportToCsv(ledger)).replace(/^\uFEFF/, "");
    return new TextEncoder().encode(
      `\uFEFFAccounts Receivable Summary\r\n${receivablesCsv}\r\nGeneral Ledger\r\n${ledgerCsv}`,
    );
  }

  const name = reportName(row.report_type);
  const report = await fetchReport(
    client,
    name,
    reportFilters(row.report_type, company, row.parameters),
  );
  return row.file_format === "csv" ? reportToCsv(report) : reportsToPdf([{ title: name, report }]);
}

async function generateInvoiceExport(
  tx: TransactionSql,
  client: ErpNextClient,
  schoolId: string,
  row: FinanceReportJobRow,
): Promise<Uint8Array> {
  const invoiceId = stringValue(row.parameters.invoice_id);
  if (!invoiceId) throw new Error("invoice_id is required");
  const response = await client.get<{ data?: Record<string, unknown> }>(
    `/api/resource/Sales%20Invoice/${encodeURIComponent(invoiceId)}`,
  );
  const artifact = generateJoInvoice(
    invoiceInput(schoolId, response.data.data ?? (response.data as Record<string, unknown>)),
  );
  await tx`
    INSERT INTO app.joinvoice_export_logs (
      school_id, erpnext_invoice_id, joinvoice_uuid, canonical_sha256, submission_status
    )
    VALUES (
      ${schoolId}::uuid, ${invoiceId}, ${artifact.uuid}::uuid, ${artifact.hash}, 'generated'
    )
    ON CONFLICT (school_id, erpnext_invoice_id) DO NOTHING
  `;
  const [stored] = await tx<{ canonical_sha256: string }[]>`
    SELECT canonical_sha256
    FROM app.joinvoice_export_logs
    WHERE school_id = ${schoolId}::uuid AND erpnext_invoice_id = ${invoiceId}
  `;
  if (stored?.canonical_sha256 !== artifact.hash) {
    throw new Error("JoInvoice content conflicts with its compliance mapping");
  }
  const value = row.file_format === "json" ? JSON.stringify(artifact.jsonEnvelope) : artifact.xml;
  return new TextEncoder().encode(value);
}

export async function renderFinanceExport(
  deps: ReportRenderDeps<FinanceExportJobData, FinanceReportJobRow>,
): Promise<Uint8Array> {
  const row = deps.record;
  if (!row) throw new Error("finance report job record is missing");
  return withSystemTenantTx(deps.primary, { schoolId: deps.context.schoolId }, async (tx) => {
    const credentials = await resolveSchoolCredentials(
      tx,
      deps.context.schoolId,
      deps.config.erpnextBaseUrl,
      deps.config.erpnextApiKey,
    );
    const [site] = await tx<{ erpnext_company_id: string | null }[]>`
      SELECT erpnext_company_id
      FROM app.erpnext_site_configs
      WHERE school_id = ${deps.context.schoolId}::uuid
    `;
    if (!site?.erpnext_company_id) throw new Error("ERPNext company is not configured");
    const client = new ErpNextClient(credentials);
    return row.report_type === "joinvoice_export"
      ? generateInvoiceExport(tx, client, deps.context.schoolId, row)
      : generateReportArtifact(client, row, site.erpnext_company_id);
  });
}
