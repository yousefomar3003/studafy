import { createHash } from "node:crypto";

import { z } from "zod";

export const financeReportTypeSchema = z.enum([
  "ar_aging",
  "general_ledger",
  "collections_vs_due",
  "family_statement",
  "joinvoice_export",
]);
export type FinanceReportType = z.infer<typeof financeReportTypeSchema>;

export const financeFileFormatSchema = z.enum(["csv", "pdf", "xml", "json"]);
export type FinanceFileFormat = z.infer<typeof financeFileFormatSchema>;

export const financeExportJobDataSchema = z
  .object({
    version: z.literal(1),
    jobId: z.string().uuid(),
    schoolId: z.string().uuid(),
    requestedByUserId: z.string().uuid(),
  })
  .strict();
export type FinanceExportJobData = z.infer<typeof financeExportJobDataSchema>;

export const reportFormatByType: Readonly<Record<FinanceReportType, readonly FinanceFileFormat[]>> =
  {
    ar_aging: ["csv", "pdf"],
    general_ledger: ["csv", "pdf"],
    collections_vs_due: ["csv", "pdf"],
    family_statement: ["csv", "pdf"],
    joinvoice_export: ["xml", "json"],
  };

export function isAllowedReportFormat(
  reportType: FinanceReportType,
  format: FinanceFileFormat,
): boolean {
  return reportFormatByType[reportType].includes(format);
}

export interface ErpNextReportColumn {
  fieldname?: string;
  label?: string;
  fieldtype?: string;
  [key: string]: unknown;
}

export interface ErpNextReportResult {
  columns: ErpNextReportColumn[];
  rows: unknown[];
  reportSummary: unknown[];
}

export function normalizeErpNextReport(value: unknown): ErpNextReportResult {
  const outer =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawMessage =
    outer.message !== null && typeof outer.message === "object"
      ? (outer.message as Record<string, unknown>)
      : outer;
  return {
    columns: Array.isArray(rawMessage.columns) ? (rawMessage.columns as ErpNextReportColumn[]) : [],
    rows: Array.isArray(rawMessage.result)
      ? rawMessage.result
      : Array.isArray(rawMessage.data)
        ? rawMessage.data
        : [],
    reportSummary: Array.isArray(rawMessage.report_summary) ? rawMessage.report_summary : [],
  };
}

function decimalDisplay(value: unknown): string | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const text = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return undefined;
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, rawFraction = ""] = unsigned.split(".");
  const fraction = `${rawFraction}000`.slice(0, 3);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function formattedCurrencyRows(
  columns: ErpNextReportColumn[],
  rows: unknown[],
): Record<string, string>[] {
  const currencyColumns = columns
    .map((column, index) => ({
      index,
      key: typeof column.fieldname === "string" ? column.fieldname : String(index),
      isCurrency: column.fieldtype === "Currency",
    }))
    .filter((column) => column.isCurrency);

  return rows.map((row) => {
    const formatted: Record<string, string> = {};
    for (const column of currencyColumns) {
      const raw = Array.isArray(row)
        ? row[column.index]
        : row !== null && typeof row === "object"
          ? (row as Record<string, unknown>)[column.key]
          : undefined;
      const display = decimalDisplay(raw);
      if (display !== undefined) formatted[column.key] = display;
    }
    return formatted;
  });
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function reportToCsv(report: ErpNextReportResult): Uint8Array {
  const headers = report.columns.map((column, index) =>
    csvCell(column.label ?? column.fieldname ?? String(index)),
  );
  const keys = report.columns.map((column, index) => column.fieldname ?? String(index));
  const lines = [headers.join(",")];
  for (const row of report.rows) {
    const values = Array.isArray(row)
      ? row
      : row !== null && typeof row === "object"
        ? keys.map((key) => (row as Record<string, unknown>)[key])
        : [row];
    lines.push(values.map(csvCell).join(","));
  }
  return new TextEncoder().encode(`\uFEFF${lines.join("\r\n")}\r\n`);
}

export interface JoInvoiceParty {
  name: string;
  taxId: string;
  address: string;
}

export interface JoInvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  lineExtensionAmount: number;
}

export interface JoInvoiceInput {
  schoolId: string;
  invoiceId: string;
  issueDate: string;
  currency: string;
  supplier: JoInvoiceParty;
  customer: JoInvoiceParty;
  lines: JoInvoiceLine[];
  taxAmount: number;
  taxExclusiveAmount: number;
  taxInclusiveAmount: number;
  payableAmount: number;
}

export interface GeneratedJoInvoice {
  uuid: string;
  xml: string;
  hash: string;
  jsonEnvelope: { invoice: string };
}

export class JoInvoiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JoInvoiceValidationError";
  }
}

const JO_INVOICE_NAMESPACE = "7a77a5d0-1cbf-5bdf-9a3e-281388bc535c";

function uuidBytes(uuid: string): Uint8Array {
  const compact = uuid.replaceAll("-", "");
  return Uint8Array.from(compact.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
}

function deterministicUuidV5(name: string): string {
  const hash = createHash("sha1")
    .update(uuidBytes(JO_INVOICE_NAMESPACE))
    .update(name, "utf8")
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function amount(value: number): string {
  if (!Number.isFinite(value)) throw new JoInvoiceValidationError("Invoice amount is not finite");
  return value.toFixed(3);
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new JoInvoiceValidationError(`${label} is required`);
  return normalized;
}

export function generateJoInvoice(input: JoInvoiceInput): GeneratedJoInvoice {
  const invoiceId = required(input.invoiceId, "Invoice ID");
  const supplierName = required(input.supplier.name, "Supplier name");
  const supplierTaxId = required(input.supplier.taxId, "Supplier tax ID");
  const supplierAddress = required(input.supplier.address, "Supplier address");
  const customerName = required(input.customer.name, "Customer name");
  const customerTaxId = required(input.customer.taxId, "Customer tax ID");
  const customerAddress = required(input.customer.address, "Customer address");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.issueDate)) {
    throw new JoInvoiceValidationError("Issue date must use YYYY-MM-DD");
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new JoInvoiceValidationError("Currency must be an ISO 4217 code");
  }
  if (input.lines.length === 0) throw new JoInvoiceValidationError("At least one line is required");

  const uuid = deterministicUuidV5(`${input.schoolId}:${invoiceId}`);
  const currency = xml(input.currency);
  const lines = input.lines
    .map((line, index) => {
      required(line.description, `Line ${index + 1} description`);
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        throw new JoInvoiceValidationError(`Line ${index + 1} quantity must be positive`);
      }
      return (
        `<cac:InvoiceLine><cbc:ID>${xml(line.id || String(index + 1))}</cbc:ID>` +
        `<cbc:InvoicedQuantity unitCode="EA">${line.quantity}</cbc:InvoicedQuantity>` +
        `<cbc:LineExtensionAmount currencyID="${currency}">${amount(line.lineExtensionAmount)}</cbc:LineExtensionAmount>` +
        `<cac:Item><cbc:Description>${xml(line.description)}</cbc:Description></cac:Item>` +
        `<cac:Price><cbc:PriceAmount currencyID="${currency}">${amount(line.unitPrice)}</cbc:PriceAmount></cac:Price>` +
        `</cac:InvoiceLine>`
      );
    })
    .join("");

  const document =
    `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"` +
    ` xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"` +
    ` xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">` +
    `<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:ProfileID>JoFotara</cbc:ProfileID>` +
    `<cbc:ID>${xml(invoiceId)}</cbc:ID><cbc:UUID>${uuid}</cbc:UUID>` +
    `<cbc:IssueDate>${input.issueDate}</cbc:IssueDate><cbc:InvoiceTypeCode>388</cbc:InvoiceTypeCode>` +
    `<cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>` +
    `<cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID>${xml(supplierTaxId)}</cbc:ID></cac:PartyIdentification>` +
    `<cac:PostalAddress><cbc:StreetName>${xml(supplierAddress)}</cbc:StreetName><cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country></cac:PostalAddress>` +
    `<cac:PartyLegalEntity><cbc:RegistrationName>${xml(supplierName)}</cbc:RegistrationName></cac:PartyLegalEntity>` +
    `</cac:Party></cac:AccountingSupplierParty>` +
    `<cac:AccountingCustomerParty><cac:Party><cac:PartyIdentification><cbc:ID>${xml(customerTaxId)}</cbc:ID></cac:PartyIdentification>` +
    `<cac:PostalAddress><cbc:StreetName>${xml(customerAddress)}</cbc:StreetName><cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country></cac:PostalAddress>` +
    `<cac:PartyLegalEntity><cbc:RegistrationName>${xml(customerName)}</cbc:RegistrationName></cac:PartyLegalEntity>` +
    `</cac:Party></cac:AccountingCustomerParty>` +
    `<cac:TaxTotal><cbc:TaxAmount currencyID="${currency}">${amount(input.taxAmount)}</cbc:TaxAmount></cac:TaxTotal>` +
    `<cac:LegalMonetaryTotal>` +
    `<cbc:LineExtensionAmount currencyID="${currency}">${amount(input.taxExclusiveAmount)}</cbc:LineExtensionAmount>` +
    `<cbc:TaxExclusiveAmount currencyID="${currency}">${amount(input.taxExclusiveAmount)}</cbc:TaxExclusiveAmount>` +
    `<cbc:TaxInclusiveAmount currencyID="${currency}">${amount(input.taxInclusiveAmount)}</cbc:TaxInclusiveAmount>` +
    `<cbc:PayableAmount currencyID="${currency}">${amount(input.payableAmount)}</cbc:PayableAmount>` +
    `</cac:LegalMonetaryTotal>${lines}</Invoice>`;
  const xmlDocument = `<?xml version="1.0" encoding="UTF-8"?>${document}`;
  const hash = createHash("sha256").update(xmlDocument, "utf8").digest("hex");
  return {
    uuid,
    xml: xmlDocument,
    hash,
    jsonEnvelope: { invoice: Buffer.from(xmlDocument, "utf8").toString("base64") },
  };
}
