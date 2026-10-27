import { randomInt } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";
import postgres from "postgres";

import { setTenantScope, withSystemTx } from "../../db/tenant-tx";

import { auditLicenseChange, licenseError } from "./context";
import { auditPlatformChange } from "./pricing";
import { readLicense, transitionLicense } from "./service";

import type { LicenseActor } from "./context";
import type { Audience, Changed } from "./service";
import type { Database, DatabasePools } from "../../db/client";
import type { PricingLine } from "@studafy/license-pricing";
import type { TransactionSql } from "postgres";

/**
 * License invoices and bank-transfer payments (session 3 of docs/billing/feature-licensing.md).
 *
 * An invoice is issued when a quote is accepted, from the quote's priced lines. It carries a unique
 * number (LIC-<year>-<n>, gapless) and a payment reference the school writes on its transfer. The
 * super admin records each transfer as a payment; partial payments are allowed, the balance is kept
 * on the invoice under its row lock, and the license activates once the invoice is paid in full --
 * or earlier, when the super admin activates it with a due date. A payment is voided with a reason,
 * never deleted, and the balance follows. Nothing here suspends a license: that is the super admin's
 * decision, made in the console.
 */

export const INVOICE_STATUSES = ["issued", "partially_paid", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

const DAY_MS = 86_400_000;

/** YYYY-MM-DD of an instant, in UTC. */
export function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------
// Platform settings: bank details, due days
// ---------------------------------------------------------------------------------------------------

export interface BankDetails {
  bankName: string;
  accountName: string;
  iban: string;
  swift: string;
  currencyCode: string;
}

const BANK_KEYS: Record<keyof BankDetails, { key: string; description: string }> = {
  bankName: {
    key: "license.bank.bank_name",
    description: "Bank name printed on license invoices.",
  },
  accountName: {
    key: "license.bank.account_name",
    description: "Account holder name printed on license invoices.",
  },
  iban: { key: "license.bank.iban", description: "IBAN printed on license invoices." },
  swift: { key: "license.bank.swift", description: "SWIFT/BIC printed on license invoices." },
  currencyCode: {
    key: "license.bank.currency",
    description: "Currency of the bank account printed on license invoices.",
  },
};

/** The platform's bank details, or null until the super admin has saved all of them. */
export async function readBankDetails(tx: TransactionSql): Promise<BankDetails | null> {
  const rows = await tx<{ key: string; text_value: string | null }[]>`
    SELECT key, text_value FROM app.platform_settings
    WHERE key = ANY(${Object.values(BANK_KEYS).map((k) => k.key)}::text[])
  `;
  const values = new Map(rows.map((row) => [row.key, row.text_value]));
  const details = {} as BankDetails;
  for (const [field, { key }] of Object.entries(BANK_KEYS) as [
    keyof BankDetails,
    { key: string },
  ][]) {
    const value = values.get(key);
    if (!value) return null;
    details[field] = value;
  }
  return details;
}

/** Save the bank details (each a platform setting), audited in the operator's home school. */
export async function writeBankDetails(
  tx: TransactionSql,
  details: BankDetails,
  actor: LicenseActor,
): Promise<BankDetails> {
  const before = await readBankDetails(tx);
  for (const [field, { key, description }] of Object.entries(BANK_KEYS) as [
    keyof BankDetails,
    { key: string; description: string },
  ][]) {
    await tx`
      INSERT INTO app.platform_settings (key, description, value_type, text_value, sensitivity, is_mutable)
      VALUES (${key}, ${description}, 'text', ${details[field]}, 'internal', true)
      ON CONFLICT (key) DO UPDATE SET
        text_value = EXCLUDED.text_value,
        updated_at = GREATEST(CURRENT_TIMESTAMP, app.platform_settings.updated_at)
    `;
  }
  const [row] = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM app.platform_settings WHERE key = ${BANK_KEYS.iban.key}
  `;
  await auditPlatformChange(tx, actor, {
    action: before ? "update" : "insert",
    targetTable: "platform_settings",
    targetId: row!.id,
    ...(before ? { oldValues: { license_bank: before } } : {}),
    newValues: { license_bank: details },
  });
  return details;
}

/** An integer platform setting, or `fallback` when it is missing. */
export async function integerSetting(
  tx: TransactionSql,
  key: string,
  fallback: number,
): Promise<number> {
  const [row] = await tx<{ value: string | null }[]>`
    SELECT integer_value::text AS value FROM app.platform_settings WHERE key = ${key}
  `;
  return row?.value ? Number(row.value) : fallback;
}

// ---------------------------------------------------------------------------------------------------
// Records and views
// ---------------------------------------------------------------------------------------------------

export interface InvoiceRecord {
  id: string;
  schoolId: string;
  licenseId: string;
  quoteId: string | null;
  number: string;
  paymentReference: string;
  currencyId: string;
  currencyCode: string;
  minorUnit: number;
  issueDate: string;
  dueDate: string;
  subtotalMinor: number;
  creditTotalMinor: number;
  adjustmentMinor: number;
  totalMinor: number;
  paidMinor: number;
  balanceMinor: number;
  status: InvoiceStatus;
  overdueAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
}

interface InvoiceRow {
  id: string;
  school_id: string;
  license_id: string;
  quote_id: string | null;
  number: string;
  payment_reference: string;
  currency_id: string;
  currency_code: string;
  minor_unit: number;
  issue_date: string;
  due_date: string;
  subtotal_minor: string;
  credit_total_minor: string;
  adjustment_minor: string;
  total_minor: string;
  paid_minor: string;
  balance_minor: string;
  status: InvoiceStatus;
  overdue_at: Date | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
}

const INVOICE_COLUMNS = (tx: TransactionSql) => tx`
  i.id::text AS id, i.school_id::text AS school_id, i.license_id::text AS license_id,
  i.quote_id::text AS quote_id, i.number, i.payment_reference, i.currency_id::text AS currency_id,
  c.code AS currency_code, c.minor_unit::int AS minor_unit, i.issue_date::text AS issue_date,
  i.due_date::text AS due_date, i.subtotal_minor::text AS subtotal_minor,
  i.credit_total_minor::text AS credit_total_minor, i.adjustment_minor::text AS adjustment_minor,
  i.total_minor::text AS total_minor, i.paid_minor::text AS paid_minor,
  i.balance_minor::text AS balance_minor, i.status, i.overdue_at, i.voided_at, i.void_reason,
  i.created_at
`;

function toInvoice(row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    schoolId: row.school_id,
    licenseId: row.license_id,
    quoteId: row.quote_id,
    number: row.number,
    paymentReference: row.payment_reference,
    currencyId: row.currency_id,
    currencyCode: row.currency_code,
    minorUnit: row.minor_unit,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    subtotalMinor: Number(row.subtotal_minor),
    creditTotalMinor: Number(row.credit_total_minor),
    adjustmentMinor: Number(row.adjustment_minor),
    totalMinor: Number(row.total_minor),
    paidMinor: Number(row.paid_minor),
    balanceMinor: Number(row.balance_minor),
    status: row.status,
    overdueAt: row.overdue_at?.toISOString() ?? null,
    voidedAt: row.voided_at?.toISOString() ?? null,
    voidReason: row.void_reason,
    createdAt: row.created_at.toISOString(),
  };
}

export async function readInvoice(
  tx: TransactionSql,
  invoiceId: string,
  options: { forUpdate?: boolean } = {},
): Promise<InvoiceRecord | null> {
  const [row] = await tx<InvoiceRow[]>`
    SELECT ${INVOICE_COLUMNS(tx)}
    FROM app.license_invoices AS i
    JOIN app.currencies AS c ON c.id = i.currency_id
    WHERE i.school_id = current_setting('app.school_id')::uuid
      AND i.id = ${invoiceId}::uuid
    ${options.forUpdate ? tx`FOR UPDATE OF i` : tx``}
  `;
  return row ? toInvoice(row) : null;
}

async function requireInvoice(
  tx: TransactionSql,
  invoiceId: string,
  actor: LicenseActor,
  options: { forUpdate?: boolean } = {},
): Promise<InvoiceRecord> {
  const invoice = await readInvoice(tx, invoiceId, options);
  if (!invoice) throw licenseError(404, ERROR_CODES.LICENSE_INVOICE_NOT_FOUND, actor.locale);
  return invoice;
}

export interface InvoiceLineView {
  position: number;
  kind: "seats" | "overlap_credit" | "adjustment";
  description: string;
  audience: Audience | null;
  planId: string | null;
  seats: number | null;
  months: number | null;
  prorateDays: number | null;
  listPricePerSeatMonthMinor: number | null;
  listAmountMinor: number | null;
  volumeDiscountBps: number | null;
  volumeDiscountMinor: number | null;
  durationDiscountBps: number | null;
  durationDiscountMinor: number | null;
  amountMinor: number;
  overlapId: string | null;
}

export interface PaymentView {
  id: string;
  invoiceId: string;
  amountMinor: number;
  currencyCode: string;
  receivedAt: string;
  bankReference: string;
  method: "bank_transfer";
  hasReceiptFile: boolean;
  note: string | null;
  recordedBy: string;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
}

export interface ReceiptView {
  id: string;
  invoiceId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  note: string | null;
  uploadedBy: string;
  status: "pending" | "matched";
  paymentId: string | null;
  matchedAt: string | null;
  createdAt: string;
}

export interface InvoiceDetail extends InvoiceRecord {
  overdue: boolean;
  lines: InvoiceLineView[];
  payments: PaymentView[];
  receipts: ReceiptView[];
  /** Where to transfer: null until the super admin has saved the platform's bank details. */
  bankDetails: BankDetails | null;
}

const num = (value: string | null): number | null => (value === null ? null : Number(value));

async function invoiceLines(tx: TransactionSql, invoiceId: string): Promise<InvoiceLineView[]> {
  const rows = await tx<
    {
      position: number;
      kind: InvoiceLineView["kind"];
      description: string;
      audience: Audience | null;
      plan_id: string | null;
      seats: number | null;
      months: number | null;
      prorate_days: number | null;
      list_price: string | null;
      list_amount: string | null;
      volume_bps: number | null;
      volume_minor: string | null;
      duration_bps: number | null;
      duration_minor: string | null;
      amount_minor: string;
      overlap_id: string | null;
    }[]
  >`
    SELECT position, kind, description, audience, plan_id::text AS plan_id, seats, months,
           prorate_days, list_price_per_seat_month_minor::text AS list_price,
           list_amount_minor::text AS list_amount, volume_discount_bps AS volume_bps,
           volume_discount_minor::text AS volume_minor, duration_discount_bps AS duration_bps,
           duration_discount_minor::text AS duration_minor, amount_minor::text AS amount_minor,
           overlap_id::text AS overlap_id
    FROM app.license_invoice_lines
    WHERE school_id = current_setting('app.school_id')::uuid AND invoice_id = ${invoiceId}::uuid
    ORDER BY position
  `;
  return rows.map((row) => ({
    position: row.position,
    kind: row.kind,
    description: row.description,
    audience: row.audience,
    planId: row.plan_id,
    seats: row.seats,
    months: row.months,
    prorateDays: row.prorate_days,
    listPricePerSeatMonthMinor: num(row.list_price),
    listAmountMinor: num(row.list_amount),
    volumeDiscountBps: row.volume_bps,
    volumeDiscountMinor: num(row.volume_minor),
    durationDiscountBps: row.duration_bps,
    durationDiscountMinor: num(row.duration_minor),
    amountMinor: Number(row.amount_minor),
    overlapId: row.overlap_id,
  }));
}

interface PaymentRow {
  id: string;
  invoice_id: string;
  amount_minor: string;
  currency_code: string;
  received_at: Date;
  bank_reference: string;
  receipt_storage_key: string | null;
  note: string | null;
  recorded_by: string;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
}

function toPayment(row: PaymentRow): PaymentView {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    amountMinor: Number(row.amount_minor),
    currencyCode: row.currency_code,
    receivedAt: row.received_at.toISOString(),
    bankReference: row.bank_reference,
    method: "bank_transfer",
    hasReceiptFile: row.receipt_storage_key !== null,
    note: row.note,
    recordedBy: row.recorded_by,
    voidedAt: row.voided_at?.toISOString() ?? null,
    voidReason: row.void_reason,
    createdAt: row.created_at.toISOString(),
  };
}

/** The school's payments, newest first; one invoice's when `invoiceId` is given. */
export async function listPayments(tx: TransactionSql, invoiceId?: string): Promise<PaymentView[]> {
  const rows = await tx<PaymentRow[]>`
    SELECT p.id::text AS id, p.invoice_id::text AS invoice_id, p.amount_minor::text AS amount_minor,
           c.code AS currency_code, p.received_at, p.bank_reference, p.receipt_storage_key, p.note,
           p.recorded_by::text AS recorded_by, p.voided_at, p.void_reason, p.created_at
    FROM app.license_payments AS p
    JOIN app.currencies AS c ON c.id = p.currency_id
    WHERE p.school_id = current_setting('app.school_id')::uuid
      ${invoiceId ? tx`AND p.invoice_id = ${invoiceId}::uuid` : tx``}
    ORDER BY p.received_at DESC, p.created_at DESC
  `;
  return rows.map(toPayment);
}

interface ReceiptRow {
  id: string;
  invoice_id: string;
  file_name: string;
  content_type: string;
  size_bytes: string;
  note: string | null;
  uploaded_by: string;
  status: "pending" | "matched";
  payment_id: string | null;
  matched_at: Date | null;
  created_at: Date;
  storage_key: string;
}

const RECEIPT_COLUMNS = (tx: TransactionSql) => tx`
  r.id::text AS id, r.invoice_id::text AS invoice_id, r.file_name, r.content_type,
  r.size_bytes::text AS size_bytes, r.note, r.uploaded_by::text AS uploaded_by, r.status,
  r.payment_id::text AS payment_id, r.matched_at, r.created_at, r.storage_key
`;

function toReceipt(row: ReceiptRow): ReceiptView {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    note: row.note,
    uploadedBy: row.uploaded_by,
    status: row.status,
    paymentId: row.payment_id,
    matchedAt: row.matched_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

async function invoiceReceipts(tx: TransactionSql, invoiceId: string): Promise<ReceiptView[]> {
  const rows = await tx<ReceiptRow[]>`
    SELECT ${RECEIPT_COLUMNS(tx)}
    FROM app.license_payment_receipts AS r
    WHERE r.school_id = current_setting('app.school_id')::uuid AND r.invoice_id = ${invoiceId}::uuid
    ORDER BY r.created_at DESC
  `;
  return rows.map(toReceipt);
}

function isOverdue(invoice: InvoiceRecord, now: Date): boolean {
  return (
    (invoice.status === "issued" || invoice.status === "partially_paid") &&
    invoice.dueDate < utcDate(now)
  );
}

/** Everything the school (or the console) shows for one invoice. */
export async function invoiceDetail(
  tx: TransactionSql,
  invoice: InvoiceRecord,
  now: Date = new Date(),
): Promise<InvoiceDetail> {
  return {
    ...invoice,
    overdue: isOverdue(invoice, now),
    lines: await invoiceLines(tx, invoice.id),
    payments: await listPayments(tx, invoice.id),
    receipts: await invoiceReceipts(tx, invoice.id),
    bankDetails: await readBankDetails(tx),
  };
}

export async function requireInvoiceDetail(
  tx: TransactionSql,
  invoiceId: string,
  actor: LicenseActor,
): Promise<InvoiceDetail> {
  return invoiceDetail(tx, await requireInvoice(tx, invoiceId, actor));
}

/** "unpaid" is issued or partially paid; "overdue" is unpaid past its due date. */
export type InvoiceFilter = "all" | InvoiceStatus | "unpaid" | "overdue";

export interface InvoiceListFilters {
  status?: InvoiceFilter;
  /** Issue dates, inclusive (YYYY-MM-DD). */
  from?: string;
  to?: string;
}

function invoiceFilterSql(tx: TransactionSql, filters: InvoiceListFilters, today: string) {
  const status = filters.status;
  return tx`
    ${
      status === "unpaid"
        ? tx`AND i.status IN ('issued', 'partially_paid')`
        : status === "overdue"
          ? tx`AND i.status IN ('issued', 'partially_paid') AND i.due_date < ${today}::date`
          : status && status !== "all"
            ? tx`AND i.status = ${status}`
            : tx``
    }
    ${filters.from ? tx`AND i.issue_date >= ${filters.from}::date` : tx``}
    ${filters.to ? tx`AND i.issue_date <= ${filters.to}::date` : tx``}
  `;
}

/** The school's invoices, newest first. */
export async function listSchoolInvoices(
  tx: TransactionSql,
  filters: InvoiceListFilters = {},
  now: Date = new Date(),
): Promise<(InvoiceRecord & { overdue: boolean })[]> {
  const rows = await tx<InvoiceRow[]>`
    SELECT ${INVOICE_COLUMNS(tx)}
    FROM app.license_invoices AS i
    JOIN app.currencies AS c ON c.id = i.currency_id
    WHERE i.school_id = current_setting('app.school_id')::uuid
      ${invoiceFilterSql(tx, filters, utcDate(now))}
    ORDER BY i.issue_date DESC, i.number DESC
  `;
  return rows.map((row) => {
    const invoice = toInvoice(row);
    return { ...invoice, overdue: isOverdue(invoice, now) };
  });
}

/**
 * Walk schools for the console's cross-school lists: one system transaction, each school's scope
 * armed in turn (the platform console's convention -- no policy is ever widened).
 */
async function forEachSchool<T>(
  database: Database | DatabasePools,
  schoolIds: string[] | null,
  fn: (tx: TransactionSql, school: { id: string; name: string }) => Promise<T[]>,
): Promise<T[]> {
  return withSystemTx(database, async (tx) => {
    const schools = await tx<{ id: string; name: string }[]>`
      SELECT id::text AS id, name FROM app.schools
      ${schoolIds ? tx`WHERE id = ANY(${schoolIds}::uuid[])` : tx``}
      ORDER BY name, id
    `;
    const out: T[] = [];
    for (const school of schools) {
      await setTenantScope(tx, school.id);
      out.push(...(await fn(tx, school)));
    }
    return out;
  });
}

export interface PlatformInvoiceListItem extends InvoiceRecord {
  schoolName: string;
  overdue: boolean;
}

/** Invoices across schools (or one school), filtered, newest first. */
export async function listInvoicesAcrossSchools(
  database: Database | DatabasePools,
  filters: InvoiceListFilters & { schoolId?: string },
  now: Date = new Date(),
): Promise<PlatformInvoiceListItem[]> {
  const items = await forEachSchool(
    database,
    filters.schoolId ? [filters.schoolId] : null,
    async (tx, school) =>
      (await listSchoolInvoices(tx, filters, now)).map((invoice) => ({
        ...invoice,
        schoolName: school.name,
      })),
  );
  return items.sort((a, b) =>
    a.issueDate === b.issueDate
      ? b.number.localeCompare(a.number)
      : b.issueDate.localeCompare(a.issueDate),
  );
}

export interface PendingReceipt extends ReceiptView {
  schoolId: string;
  schoolName: string;
  invoiceNumber: string;
  invoiceBalanceMinor: number;
  currencyCode: string;
}

/** Receipts waiting to be matched, across schools, oldest first. */
export async function listPendingReceipts(
  database: Database | DatabasePools,
): Promise<PendingReceipt[]> {
  const items = await forEachSchool(database, null, async (tx, school) => {
    const rows = await tx<
      (ReceiptRow & { number: string; balance_minor: string; currency_code: string })[]
    >`
      SELECT ${RECEIPT_COLUMNS(tx)}, i.number, i.balance_minor::text AS balance_minor,
             c.code AS currency_code
      FROM app.license_payment_receipts AS r
      JOIN app.license_invoices AS i ON i.id = r.invoice_id AND i.school_id = r.school_id
      JOIN app.currencies AS c ON c.id = i.currency_id
      WHERE r.school_id = current_setting('app.school_id')::uuid AND r.status = 'pending'
      ORDER BY r.created_at
    `;
    return rows.map((row) => ({
      ...toReceipt(row),
      schoolId: school.id,
      schoolName: school.name,
      invoiceNumber: row.number,
      invoiceBalanceMinor: Number(row.balance_minor),
      currencyCode: row.currency_code,
    }));
  });
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface FinanceTotals {
  currencyCode: string;
  minorUnit: number;
  receivedThisMonthMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  unpaidInvoices: number;
  overdueInvoices: number;
}

/**
 * The finance overview, per currency: payments received this calendar month (UTC), the balance of
 * every unpaid invoice, and the part of it past due.
 */
export async function financeTotals(
  database: Database | DatabasePools,
  now: Date = new Date(),
): Promise<FinanceTotals[]> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const today = utcDate(now);
  const rows = await forEachSchool(
    database,
    null,
    async (tx) =>
      tx<
        {
          currency_code: string;
          minor_unit: number;
          received: string;
          outstanding: string;
          overdue: string;
          unpaid: number;
          overdue_count: number;
        }[]
      >`
      WITH open_invoices AS (
        SELECT i.currency_id, i.balance_minor, i.due_date
        FROM app.license_invoices AS i
        WHERE i.school_id = current_setting('app.school_id')::uuid
          AND i.status IN ('issued', 'partially_paid')
      ),
      received AS (
        SELECT p.currency_id, sum(p.amount_minor) AS amount
        FROM app.license_payments AS p
        WHERE p.school_id = current_setting('app.school_id')::uuid
          AND p.voided_at IS NULL
          AND p.received_at >= ${monthStart}
          AND p.received_at <= ${now}
        GROUP BY p.currency_id
      ),
      currencies AS (
        SELECT currency_id FROM open_invoices UNION SELECT currency_id FROM received
      )
      SELECT c.code AS currency_code, c.minor_unit::int AS minor_unit,
             COALESCE((SELECT r.amount FROM received AS r WHERE r.currency_id = cur.currency_id), 0)::text AS received,
             COALESCE((SELECT sum(o.balance_minor) FROM open_invoices AS o WHERE o.currency_id = cur.currency_id), 0)::text AS outstanding,
             COALESCE((SELECT sum(o.balance_minor) FROM open_invoices AS o
                       WHERE o.currency_id = cur.currency_id AND o.due_date < ${today}::date), 0)::text AS overdue,
             (SELECT count(*) FROM open_invoices AS o WHERE o.currency_id = cur.currency_id)::int AS unpaid,
             (SELECT count(*) FROM open_invoices AS o
              WHERE o.currency_id = cur.currency_id AND o.due_date < ${today}::date)::int AS overdue_count
      FROM currencies AS cur
      JOIN app.currencies AS c ON c.id = cur.currency_id
    `,
  );

  const totals = new Map<string, FinanceTotals>();
  for (const row of rows) {
    const entry = totals.get(row.currency_code) ?? {
      currencyCode: row.currency_code,
      minorUnit: row.minor_unit,
      receivedThisMonthMinor: 0,
      outstandingMinor: 0,
      overdueMinor: 0,
      unpaidInvoices: 0,
      overdueInvoices: 0,
    };
    entry.receivedThisMonthMinor += Number(row.received);
    entry.outstandingMinor += Number(row.outstanding);
    entry.overdueMinor += Number(row.overdue);
    entry.unpaidInvoices += row.unpaid;
    entry.overdueInvoices += row.overdue_count;
    totals.set(row.currency_code, entry);
  }
  return [...totals.values()].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
}

// ---------------------------------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------------------------------

/** Crockford's base32 without I, L, O, U: nothing a person can misread on a transfer form. */
const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newPaymentReference(): string {
  const chunk = () =>
    Array.from({ length: 4 }, () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]).join(
      "",
    );
  return `STF-${chunk()}-${chunk()}`;
}

function invoiceSnapshot(invoice: InvoiceRecord): Record<string, unknown> {
  return {
    number: invoice.number,
    payment_reference: invoice.paymentReference,
    license_id: invoice.licenseId,
    quote_id: invoice.quoteId,
    currency_code: invoice.currencyCode,
    issue_date: invoice.issueDate,
    due_date: invoice.dueDate,
    total_minor: invoice.totalMinor,
    paid_minor: invoice.paidMinor,
    status: invoice.status,
  };
}

export interface IssueInvoiceInput {
  licenseId: string;
  quoteId: string | null;
  currencyId: string;
  /** The priced lines, in order: seats, credits, the adjustment. */
  lines: readonly PricingLine[];
  /** Plan id per audience, for the seat lines. */
  planIds: Partial<Record<Audience, string | null>>;
}

/**
 * Issue an invoice for priced lines. The number is the next of the issue year; the payment reference
 * is random and unique (a collision, about one in a trillion, is retried under a savepoint). An
 * invoice with nothing to pay -- credits covered it -- is issued already paid.
 */
export async function issueInvoice(
  tx: TransactionSql,
  schoolId: string,
  input: IssueInvoiceInput,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<InvoiceRecord> {
  const issueDate = utcDate(now);
  const dueDays = await integerSetting(tx, "license.invoice_due_days", 30);
  const dueDate = utcDate(new Date(Date.parse(issueDate) + dueDays * DAY_MS));

  const lines = input.lines.filter(
    (line) => line.kind !== "overlap_credit" || line.amountMinor < 0,
  );
  const subtotal = lines.reduce((s, l) => s + (l.kind === "seats" ? l.amountMinor : 0), 0);
  const credits = -lines.reduce((s, l) => s + (l.kind === "overlap_credit" ? l.amountMinor : 0), 0);
  const adjustment = lines.reduce((s, l) => s + (l.kind === "adjustment" ? l.amountMinor : 0), 0);
  const total = subtotal - credits + adjustment;
  const status: InvoiceStatus = total === 0 ? "paid" : "issued";

  const [numbered] = await tx<{ number: string }[]>`
    SELECT app.next_license_invoice_number(${issueDate}::date) AS number
  `;
  const number = numbered!.number;

  let invoiceId: string | null = null;
  for (let attempt = 0; invoiceId === null; attempt += 1) {
    try {
      const [row] = await tx.savepoint(
        (sp) => sp<{ id: string }[]>`
          INSERT INTO app.license_invoices (
            school_id, license_id, quote_id, number, payment_reference, currency_id, issue_date,
            due_date, subtotal_minor, credit_total_minor, adjustment_minor, total_minor, status,
            issued_by
          ) VALUES (
            ${schoolId}::uuid, ${input.licenseId}::uuid, ${input.quoteId}::uuid, ${number},
            ${newPaymentReference()}, ${input.currencyId}::uuid, ${issueDate}::date,
            ${dueDate}::date, ${subtotal}, ${credits}, ${adjustment}, ${total}, ${status},
            ${actor.userId}::uuid
          )
          RETURNING id::text AS id
        `,
      );
      invoiceId = row!.id;
    } catch (err) {
      const collision =
        err instanceof postgres.PostgresError &&
        err.constraint_name === "uq_license_invoices_payment_reference";
      if (!collision || attempt >= 4) throw err;
    }
  }

  const lineRows = lines.map((line, index) => {
    const base = {
      school_id: schoolId,
      invoice_id: invoiceId,
      position: index + 1,
      kind: line.kind,
      audience: null as string | null,
      plan_id: null as string | null,
      seats: null as number | null,
      months: null as number | null,
      prorate_days: null as number | null,
      list_price_per_seat_month_minor: null as number | null,
      list_amount_minor: null as number | null,
      volume_discount_bps: null as number | null,
      volume_discount_minor: null as number | null,
      duration_discount_bps: null as number | null,
      duration_discount_minor: null as number | null,
      amount_minor: line.amountMinor,
      overlap_id: null as string | null,
    };
    if (line.kind === "seats") {
      const period = line.prorateDays ? `${line.prorateDays} days` : `${line.months} months`;
      return {
        ...base,
        description: `${line.tierName}: ${line.seats} ${line.audience} seats, ${period}`,
        audience: line.audience,
        plan_id: input.planIds[line.audience] ?? null,
        seats: line.seats,
        months: line.months,
        prorate_days: line.prorateDays,
        list_price_per_seat_month_minor: line.listPricePerSeatMonthMinor,
        list_amount_minor: line.listAmountMinor,
        volume_discount_bps: line.volumeDiscountBps,
        volume_discount_minor: line.volumeDiscountMinor,
        duration_discount_bps: line.durationDiscountBps,
        duration_discount_minor: line.durationDiscountMinor,
      };
    }
    if (line.kind === "overlap_credit") {
      return { ...base, description: line.description, overlap_id: line.reference };
    }
    return { ...base, description: `Adjustment: ${line.reason}` };
  });
  if (lineRows.length > 0) {
    await tx`INSERT INTO app.license_invoice_lines ${tx(lineRows)}`;
  }

  const invoice = (await readInvoice(tx, invoiceId))!;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "insert",
    targetTable: "license_invoices",
    targetId: invoice.id,
    newValues: { ...invoiceSnapshot(invoice), lines: lineRows.length },
  });
  return invoice;
}

// ---------------------------------------------------------------------------------------------------
// Changes (super admin)
// ---------------------------------------------------------------------------------------------------

async function setInvoicePaid(
  tx: TransactionSql,
  schoolId: string,
  before: InvoiceRecord,
  paidMinor: number,
  actor: LicenseActor,
): Promise<InvoiceRecord> {
  const status: InvoiceStatus =
    paidMinor === 0 ? "issued" : paidMinor >= before.totalMinor ? "paid" : "partially_paid";
  await tx`
    UPDATE app.license_invoices
    SET paid_minor = ${paidMinor}, status = ${status},
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${before.id}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "license_invoices",
    targetId: before.id,
    oldValues: { paid_minor: before.paidMinor, status: before.status },
    newValues: { paid_minor: paidMinor, status },
  });
  return (await readInvoice(tx, before.id))!;
}

/**
 * Activate the invoice's license if it is not yet in force (draft or awaiting payment). Skipped,
 * not refused, when the school already has another active license: the new one waits for the super
 * admin.
 */
export async function activateLicenseFor(
  tx: TransactionSql,
  schoolId: string,
  invoice: InvoiceRecord,
  actor: LicenseActor,
  now: Date,
): Promise<Omit<Changed<unknown>, "result"> & { activated: boolean }> {
  const license = await readLicense(tx, invoice.licenseId);
  if (!license || (license.status !== "draft" && license.status !== "awaiting_payment")) {
    return { activated: false, versions: new Map(), pending: [] };
  }
  const [other] = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM app.school_licenses
    WHERE school_id = current_setting('app.school_id')::uuid AND status = 'active'
  `;
  if (other) return { activated: false, versions: new Map(), pending: [] };
  const changed = await transitionLicense(tx, schoolId, license.id, "active", actor, now);
  return { activated: true, versions: changed.versions, pending: changed.pending };
}

export interface PaymentResult {
  payment: PaymentView;
  invoice: InvoiceRecord;
  licenseActivated: boolean;
}

export interface RecordPaymentInput {
  amountMinor: number;
  receivedAt: Date;
  bankReference: string;
  note?: string | null;
  /** A school receipt this payment is evidenced by: matched in the same transaction. */
  receiptId?: string | null;
  /** A file the super admin uploaded, already promoted to permanent storage. */
  receiptStorageKey?: string | null;
}

/** Record a bank transfer. When it completes the invoice, the license activates. */
export async function recordPayment(
  tx: TransactionSql,
  schoolId: string,
  invoiceId: string,
  input: RecordPaymentInput,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<Changed<PaymentResult>> {
  const invoice = await requireInvoice(tx, invoiceId, actor, { forUpdate: true });
  if (invoice.status !== "issued" && invoice.status !== "partially_paid") {
    throw licenseError(409, ERROR_CODES.LICENSE_INVOICE_NOT_PAYABLE, actor.locale);
  }
  if (input.amountMinor > invoice.balanceMinor) {
    throw licenseError(422, ERROR_CODES.LICENSE_PAYMENT_EXCEEDS_BALANCE, actor.locale);
  }

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.license_payments (
      school_id, invoice_id, amount_minor, currency_id, received_at, bank_reference,
      receipt_storage_key, recorded_by, note
    ) VALUES (
      ${schoolId}::uuid, ${invoiceId}::uuid, ${input.amountMinor}, ${invoice.currencyId}::uuid,
      ${input.receivedAt}, ${input.bankReference.trim()}, ${input.receiptStorageKey ?? null},
      ${actor.userId}::uuid, ${input.note?.trim() || null}
    )
    RETURNING id::text AS id
  `;
  const paymentId = row!.id;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "insert",
    targetTable: "license_payments",
    targetId: paymentId,
    newValues: {
      invoice_id: invoiceId,
      amount_minor: input.amountMinor,
      received_at: input.receivedAt.toISOString(),
      bank_reference: input.bankReference.trim(),
      has_receipt_file: Boolean(input.receiptStorageKey),
    },
  });

  if (input.receiptId) await matchReceipt(tx, schoolId, input.receiptId, paymentId, actor);

  const after = await setInvoicePaid(
    tx,
    schoolId,
    invoice,
    invoice.paidMinor + input.amountMinor,
    actor,
  );
  const activation =
    after.status === "paid"
      ? await activateLicenseFor(tx, schoolId, after, actor, now)
      : { activated: false, versions: new Map<string, number>(), pending: [] };

  const payment = (await listPayments(tx, invoiceId)).find((p) => p.id === paymentId)!;
  return {
    result: { payment, invoice: after, licenseActivated: activation.activated },
    versions: activation.versions,
    pending: activation.pending,
  };
}

/**
 * Void a payment with a reason. The invoice's paid amount and status follow; a receipt matched to it
 * goes back to pending. The license is left as it is: suspending it is the super admin's call.
 */
export async function voidPayment(
  tx: TransactionSql,
  schoolId: string,
  paymentId: string,
  reason: string,
  actor: LicenseActor,
): Promise<{ payment: PaymentView; invoice: InvoiceRecord }> {
  const [payment] = await tx<
    { invoice_id: string; amount_minor: string; voided_at: Date | null }[]
  >`
    SELECT invoice_id::text AS invoice_id, amount_minor::text AS amount_minor, voided_at
    FROM app.license_payments
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${paymentId}::uuid
  `;
  if (!payment) throw licenseError(404, ERROR_CODES.LICENSE_PAYMENT_NOT_FOUND, actor.locale);
  // The invoice row lock first, as recordPayment takes it: the two serialize on it.
  const invoice = await requireInvoice(tx, payment.invoice_id, actor, { forUpdate: true });
  const [locked] = await tx<{ voided_at: Date | null }[]>`
    SELECT voided_at FROM app.license_payments
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${paymentId}::uuid
    FOR UPDATE
  `;
  if (locked!.voided_at) throw licenseError(409, ERROR_CODES.LICENSE_PAYMENT_VOIDED, actor.locale);

  await tx`
    UPDATE app.license_payments
    SET voided_at = CURRENT_TIMESTAMP, voided_by = ${actor.userId}::uuid,
        void_reason = ${reason.trim()}, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${paymentId}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "license_payments",
    targetId: paymentId,
    oldValues: { voided_at: null },
    newValues: { voided_at: new Date().toISOString(), void_reason: reason.trim() },
  });

  const unmatched = await tx<{ id: string }[]>`
    UPDATE app.license_payment_receipts
    SET status = 'pending', payment_id = NULL, matched_at = NULL, matched_by = NULL,
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND payment_id = ${paymentId}::uuid
    RETURNING id::text AS id
  `;
  for (const receipt of unmatched) {
    await auditLicenseChange(tx, schoolId, actor, {
      action: "update",
      targetTable: "license_payment_receipts",
      targetId: receipt.id,
      oldValues: { status: "matched", payment_id: paymentId },
      newValues: { status: "pending", payment_id: null },
    });
  }

  const after = await setInvoicePaid(
    tx,
    schoolId,
    invoice,
    invoice.paidMinor - Number(payment.amount_minor),
    actor,
  );
  const view = (await listPayments(tx, invoice.id)).find((p) => p.id === paymentId)!;
  return { payment: view, invoice: after };
}

/** Void an invoice nobody has paid. Its overlap credits become available to the next quote. */
export async function voidInvoice(
  tx: TransactionSql,
  schoolId: string,
  invoiceId: string,
  reason: string,
  actor: LicenseActor,
): Promise<InvoiceRecord> {
  const invoice = await requireInvoice(tx, invoiceId, actor, { forUpdate: true });
  if (invoice.status === "void") {
    throw licenseError(409, ERROR_CODES.LICENSE_INVOICE_NOT_PAYABLE, actor.locale);
  }
  if (invoice.paidMinor > 0) {
    throw licenseError(409, ERROR_CODES.LICENSE_INVOICE_HAS_PAYMENTS, actor.locale);
  }
  await tx`
    UPDATE app.license_invoices
    SET status = 'void', voided_at = CURRENT_TIMESTAMP, voided_by = ${actor.userId}::uuid,
        void_reason = ${reason.trim()}, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${invoiceId}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "license_invoices",
    targetId: invoiceId,
    oldValues: { status: invoice.status },
    newValues: { status: "void", void_reason: reason.trim() },
  });
  return (await readInvoice(tx, invoiceId))!;
}

/**
 * Activate the invoice's license before it is paid, with the date payment is now due. The invoice
 * stays open; its due date moves (and an overdue mark is cleared when the new date is not past).
 */
export async function activateEarly(
  tx: TransactionSql,
  schoolId: string,
  invoiceId: string,
  dueDate: string,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<Changed<{ invoice: InvoiceRecord; licenseActivated: boolean }>> {
  const invoice = await requireInvoice(tx, invoiceId, actor, { forUpdate: true });
  if (invoice.status !== "issued" && invoice.status !== "partially_paid") {
    throw licenseError(409, ERROR_CODES.LICENSE_INVOICE_NOT_PAYABLE, actor.locale);
  }
  if (dueDate < invoice.issueDate)
    throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);

  const clearsOverdue = dueDate >= utcDate(now);
  await tx`
    UPDATE app.license_invoices
    SET due_date = ${dueDate}::date,
        overdue_at = ${clearsOverdue ? null : tx`overdue_at`},
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${invoiceId}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "license_invoices",
    targetId: invoiceId,
    oldValues: { due_date: invoice.dueDate, overdue_at: invoice.overdueAt },
    newValues: { due_date: dueDate, overdue_at: clearsOverdue ? null : invoice.overdueAt },
  });

  const license = await readLicense(tx, invoice.licenseId);
  if (license?.status === "active") {
    return {
      result: { invoice: (await readInvoice(tx, invoiceId))!, licenseActivated: false },
      versions: new Map(),
      pending: [],
    };
  }
  if (!license || (license.status !== "draft" && license.status !== "awaiting_payment")) {
    throw licenseError(409, ERROR_CODES.LICENSE_INVALID_TRANSITION, actor.locale);
  }
  // A second active license is refused by uq_school_licenses_one_active (LICENSE_ALREADY_ACTIVE).
  const changed = await transitionLicense(tx, schoolId, license.id, "active", actor, now);
  return {
    result: { invoice: (await readInvoice(tx, invoiceId))!, licenseActivated: true },
    versions: changed.versions,
    pending: changed.pending,
  };
}

// ---------------------------------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------------------------------

export interface ReceiptFile {
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/** The school uploads a transfer receipt for one of its invoices. */
export async function createReceipt(
  tx: TransactionSql,
  schoolId: string,
  invoiceId: string,
  file: ReceiptFile,
  note: string | null,
  actor: LicenseActor,
): Promise<ReceiptView> {
  const invoice = await requireInvoice(tx, invoiceId, actor);
  if (invoice.status === "void") {
    throw licenseError(409, ERROR_CODES.LICENSE_INVOICE_NOT_PAYABLE, actor.locale);
  }
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.license_payment_receipts (
      school_id, invoice_id, storage_key, file_name, content_type, size_bytes, note, uploaded_by
    ) VALUES (
      ${schoolId}::uuid, ${invoiceId}::uuid, ${file.storageKey}, ${file.fileName},
      ${file.contentType}, ${file.sizeBytes}, ${note?.trim() || null}, ${actor.userId}::uuid
    )
    RETURNING id::text AS id
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "insert",
    targetTable: "license_payment_receipts",
    targetId: row!.id,
    newValues: { invoice_id: invoiceId, file_name: file.fileName, size_bytes: file.sizeBytes },
  });
  return (await invoiceReceipts(tx, invoiceId)).find((r) => r.id === row!.id)!;
}

export async function readReceipt(
  tx: TransactionSql,
  receiptId: string,
): Promise<(ReceiptView & { storageKey: string }) | null> {
  const [row] = await tx<ReceiptRow[]>`
    SELECT ${RECEIPT_COLUMNS(tx)}
    FROM app.license_payment_receipts AS r
    WHERE r.school_id = current_setting('app.school_id')::uuid AND r.id = ${receiptId}::uuid
  `;
  return row ? { ...toReceipt(row), storageKey: row.storage_key } : null;
}

/** The storage key of a payment's attached file, or null. */
export async function paymentReceiptKey(
  tx: TransactionSql,
  paymentId: string,
): Promise<string | null | undefined> {
  const [row] = await tx<{ key: string | null }[]>`
    SELECT receipt_storage_key AS key FROM app.license_payments
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${paymentId}::uuid
  `;
  return row ? row.key : undefined;
}

/** Tie a pending receipt to the payment it evidences (same invoice, not voided). */
export async function matchReceipt(
  tx: TransactionSql,
  schoolId: string,
  receiptId: string,
  paymentId: string,
  actor: LicenseActor,
): Promise<ReceiptView> {
  const [receipt] = await tx<{ invoice_id: string; status: string }[]>`
    SELECT invoice_id::text AS invoice_id, status FROM app.license_payment_receipts
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${receiptId}::uuid
    FOR UPDATE
  `;
  if (!receipt) throw licenseError(404, ERROR_CODES.LICENSE_RECEIPT_NOT_FOUND, actor.locale);
  if (receipt.status !== "pending") {
    throw licenseError(409, ERROR_CODES.LICENSE_RECEIPT_ALREADY_MATCHED, actor.locale);
  }
  const [payment] = await tx<{ invoice_id: string; voided_at: Date | null }[]>`
    SELECT invoice_id::text AS invoice_id, voided_at FROM app.license_payments
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${paymentId}::uuid
  `;
  if (!payment) throw licenseError(404, ERROR_CODES.LICENSE_PAYMENT_NOT_FOUND, actor.locale);
  if (payment.voided_at) throw licenseError(409, ERROR_CODES.LICENSE_PAYMENT_VOIDED, actor.locale);
  if (payment.invoice_id !== receipt.invoice_id) {
    throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);
  }

  await tx`
    UPDATE app.license_payment_receipts
    SET status = 'matched', payment_id = ${paymentId}::uuid, matched_at = CURRENT_TIMESTAMP,
        matched_by = ${actor.userId}::uuid, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${receiptId}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "license_payment_receipts",
    targetId: receiptId,
    oldValues: { status: "pending", payment_id: null },
    newValues: { status: "matched", payment_id: paymentId },
  });
  return (await invoiceReceipts(tx, receipt.invoice_id)).find((r) => r.id === receiptId)!;
}
