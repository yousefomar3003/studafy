/**
 * Family financial view aggregation (ST-127).
 *
 * A parent-facing household read: all linked children's invoices, fee-schedule installments, and
 * payment receipts, served from the local read models — `invoice_cache`, `installment_cache`,
 * `payment_cache` — with no ERPNext round trip. ERPNext remains the system of record; the daily
 * reconciliation job (ST-122) keeps the installment arm aligned, and the webhook projections keep
 * the invoice and payment arms fed. This module only reads and presents.
 *
 * ## Where the totals come from
 *
 * Household and per-student balances are derived from `invoice_cache` rows: `total` is billed,
 * `outstanding` is what ERPNext reports remaining, and `paid` is the difference. Receipts are
 * listed but deliberately NOT summed into the balance — an invoice's `outstanding` already reflects
 * every submitted Payment Entry, so adding receipt amounts would count the same money twice.
 *
 * ## Currency grouping
 *
 * Totals are accumulated in minor units (bigint) and grouped by ISO currency code, because JOD is
 * the currency in practice but summing across currencies would be wrong money. The exponent comes
 * from `app.currencies`, never assumed to be 2 (see `currency.ts`).
 */

import { formatMinorUnits } from "../currency";

import type {
  FamilyFinancialViewResponse,
  FamilyPresentation,
  FamilyStudentSection,
} from "./schemas";
import type { SupportedLocale } from "../../../middleware/locale";
import type { TransactionSql } from "postgres";

interface InvoiceCacheRow {
  student_id: string;
  erpnext_docname: string;
  erpnext_status: string;
  issued_date: string;
  due_date: string | null;
  total_amount_minor: bigint;
  outstanding_amount_minor: bigint;
  currency: string;
  currency_minor_unit: number;
  last_synced_at: Date;
}

interface InstallmentCacheRow {
  student_id: string;
  erpnext_fee_schedule_id: string;
  fee_structure_id: string | null;
  due_date: string;
  total_amount_minor: bigint;
  paid_amount_minor: bigint;
  outstanding_amount_minor: bigint;
  currency: string;
  currency_minor_unit: number;
  status: "pending" | "partially_paid" | "paid" | "overdue";
  synced_at: Date;
}

type PaymentCacheStatus = "pending" | "confirmed" | "failed";
type PaymentMode = "cash" | "bank_transfer" | "card_external";

interface PaymentCacheRow {
  student_id: string;
  id: string;
  erpnext_docname: string;
  erpnext_invoice_id: string | null;
  amount_minor: bigint;
  currency: string;
  currency_minor_unit: number;
  payment_mode: PaymentMode | null;
  status: PaymentCacheStatus;
  erpnext_status: string;
  receipt_url: string | null;
  payment_date: string;
  confirmed_at: Date | null;
  last_synced_at: Date;
}

interface TotalsEntry {
  minorUnit: number;
  total: bigint;
  paid: bigint;
  outstanding: bigint;
}

function toMinor(value: string | number): bigint {
  return BigInt(value);
}

function toNullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function toDate(value: unknown): Date {
  return new Date(value as string | number | Date);
}

function parseInvoiceRow(raw: Record<string, unknown>): InvoiceCacheRow {
  return {
    student_id: String(raw.student_id),
    erpnext_docname: String(raw.erpnext_docname),
    erpnext_status: String(raw.erpnext_status),
    issued_date: String(raw.issued_date),
    due_date: toNullableString(raw.due_date),
    total_amount_minor: toMinor(raw.total_amount_minor as string | number),
    outstanding_amount_minor: toMinor(raw.outstanding_amount_minor as string | number),
    currency: String(raw.currency),
    currency_minor_unit: Number(raw.currency_minor_unit),
    last_synced_at: toDate(raw.last_synced_at),
  };
}

function parseInstallmentRow(raw: Record<string, unknown>): InstallmentCacheRow {
  return {
    student_id: String(raw.student_id),
    erpnext_fee_schedule_id: String(raw.erpnext_fee_schedule_id),
    fee_structure_id: toNullableString(raw.fee_structure_id),
    due_date: String(raw.due_date),
    total_amount_minor: toMinor(raw.total_amount_minor as string | number),
    paid_amount_minor: toMinor(raw.paid_amount_minor as string | number),
    outstanding_amount_minor: toMinor(raw.outstanding_amount_minor as string | number),
    currency: String(raw.currency),
    currency_minor_unit: Number(raw.currency_minor_unit),
    status: String(raw.status) as InstallmentCacheRow["status"],
    synced_at: toDate(raw.synced_at),
  };
}

function parsePaymentRow(raw: Record<string, unknown>): PaymentCacheRow {
  return {
    student_id: String(raw.student_id),
    id: String(raw.id),
    erpnext_docname: String(raw.erpnext_docname),
    erpnext_invoice_id: toNullableString(raw.erpnext_invoice_id),
    amount_minor: toMinor(raw.amount_minor as string | number),
    currency: String(raw.currency),
    currency_minor_unit: Number(raw.currency_minor_unit),
    payment_mode: (raw.payment_mode == null
      ? null
      : String(raw.payment_mode)) as PaymentMode | null,
    status: String(raw.status) as PaymentCacheStatus,
    erpnext_status: String(raw.erpnext_status),
    receipt_url: toNullableString(raw.receipt_url),
    payment_date: String(raw.payment_date),
    confirmed_at: raw.confirmed_at == null ? null : toDate(raw.confirmed_at),
    last_synced_at: toDate(raw.last_synced_at),
  };
}

function addTotals(
  acc: Map<string, TotalsEntry>,
  currency: string,
  minorUnit: number,
  total: bigint,
  paid: bigint,
  outstanding: bigint,
): void {
  const entry = acc.get(currency) ?? { minorUnit, total: 0n, paid: 0n, outstanding: 0n };
  entry.total += total;
  entry.paid += paid;
  entry.outstanding += outstanding;
  acc.set(currency, entry);
}

function toCurrencyTotal(currency: string, entry: TotalsEntry) {
  return {
    currency,
    currency_minor_unit: entry.minorUnit,
    total_amount: formatMinorUnits(entry.total, entry.minorUnit),
    total_amount_minor: Number(entry.total),
    paid_amount: formatMinorUnits(entry.paid, entry.minorUnit),
    paid_amount_minor: Number(entry.paid),
    outstanding_amount: formatMinorUnits(entry.outstanding, entry.minorUnit),
    outstanding_amount_minor: Number(entry.outstanding),
  };
}

function toInvoiceSummary(row: InvoiceCacheRow, payRedirectBaseUrl: string | undefined) {
  const minorUnit = row.currency_minor_unit;
  const hasOutstanding = row.outstanding_amount_minor > 0n;
  return {
    erpnext_docname: row.erpnext_docname,
    erpnext_status: row.erpnext_status,
    issued_date: row.issued_date,
    due_date: row.due_date,
    total_amount: formatMinorUnits(row.total_amount_minor, minorUnit),
    total_amount_minor: Number(row.total_amount_minor),
    outstanding_amount: formatMinorUnits(row.outstanding_amount_minor, minorUnit),
    outstanding_amount_minor: Number(row.outstanding_amount_minor),
    currency: row.currency,
    currency_minor_unit: minorUnit,
    pay_online_url: hasOutstanding
      ? buildPayOnlineUrl(payRedirectBaseUrl, row.erpnext_docname, row.student_id)
      : null,
    synced_at: row.last_synced_at.toISOString(),
  };
}

function toInstallmentSummary(row: InstallmentCacheRow) {
  const minorUnit = row.currency_minor_unit;
  return {
    erpnext_fee_schedule_id: row.erpnext_fee_schedule_id,
    fee_structure_id: row.fee_structure_id,
    due_date: row.due_date,
    total_amount: formatMinorUnits(row.total_amount_minor, minorUnit),
    total_amount_minor: Number(row.total_amount_minor),
    paid_amount: formatMinorUnits(row.paid_amount_minor, minorUnit),
    paid_amount_minor: Number(row.paid_amount_minor),
    outstanding_amount: formatMinorUnits(row.outstanding_amount_minor, minorUnit),
    outstanding_amount_minor: Number(row.outstanding_amount_minor),
    currency: row.currency,
    currency_minor_unit: minorUnit,
    status: row.status,
    synced_at: row.synced_at.toISOString(),
  };
}

function toPaymentSummary(row: PaymentCacheRow) {
  const minorUnit = row.currency_minor_unit;
  return {
    id: row.id,
    erpnext_payment_entry_id: row.erpnext_docname,
    erpnext_invoice_id: row.erpnext_invoice_id,
    amount: formatMinorUnits(row.amount_minor, minorUnit),
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    currency_minor_unit: minorUnit,
    payment_mode: row.payment_mode,
    status: row.status,
    erpnext_status: row.erpnext_status,
    receipt_url: row.receipt_url,
    payment_date: row.payment_date,
    confirmed_at: row.confirmed_at ? row.confirmed_at.toISOString() : null,
    last_synced_at: row.last_synced_at.toISOString(),
  };
}

/**
 * The pay-online redirect target for one outstanding invoice.
 *
 * Composition only — the gateway decides no business rule. The base URL is configuration
 * (`PAYMENT_REDIRECT_BASE_URL`), and the invoice/student identity is carried as query parameters
 * for the payment frontend to act on. Null when no base URL is configured.
 */
export function buildPayOnlineUrl(
  baseUrl: string | undefined,
  invoiceId: string,
  studentId: string,
): string | null {
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  url.searchParams.set("invoice", invoiceId);
  url.searchParams.set("student", studentId);
  return url.toString();
}

/**
 * Aggregate every cached finance record for the family's students into the view response.
 *
 * Access to the family must already have been resolved by the caller (see `familyCustomers` in
 * `../reports/service`); this function only reads rows it is given permission to read by tenant
 * RLS and the caller-supplied student set.
 */
export async function aggregateFamilyFinancialView(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
  studentIds: string[],
  locale: SupportedLocale,
  payRedirectBaseUrl: string | undefined,
): Promise<FamilyFinancialViewResponse> {
  const presentation: FamilyPresentation = {
    locale,
    direction: locale === "ar" ? "rtl" : "ltr",
    currency: "JOD",
    currency_precision: 3,
  };

  const reconciled = await tx<{ job_run_at: Date }[]>`
    SELECT job_run_at
    FROM app.finance_reconciliation_logs
    WHERE school_id = ${schoolId}::uuid
    ORDER BY job_run_at DESC
    LIMIT 1
  `;
  const reconciledAt = reconciled[0]?.job_run_at.toISOString() ?? null;

  if (studentIds.length === 0) {
    return {
      family_id: familyId,
      students: [],
      household_totals: [],
      data_as_of: null,
      reconciled_at: reconciledAt,
      presentation,
    };
  }

  const [students, invoices, installments, payments] = await Promise.all([
    tx<{ id: string; admission_number: string }[]>`
      SELECT id, admission_number
      FROM app.students
      WHERE school_id = ${schoolId}::uuid AND id = ANY(${studentIds}::uuid[])
    `,
    tx<Record<string, unknown>[]>`
      SELECT ic.student_id, ic.erpnext_docname, ic.erpnext_status,
             ic.issued_date::text AS issued_date, ic.due_date::text AS due_date,
             ic.total_amount_minor, ic.outstanding_amount_minor,
             ic.last_synced_at, c.code AS currency, c.minor_unit AS currency_minor_unit
      FROM app.invoice_cache AS ic
      JOIN app.currencies AS c ON c.id = ic.currency_id
      WHERE ic.school_id = ${schoolId}::uuid AND ic.student_id = ANY(${studentIds}::uuid[])
      ORDER BY ic.issued_date DESC, ic.erpnext_docname
    `,
    tx<Record<string, unknown>[]>`
      SELECT fsc.student_id, fsc.erpnext_fee_schedule_id, fsc.fee_structure_id,
             fsc.due_date::text AS due_date,
             fsc.total_amount_minor, fsc.paid_amount_minor, fsc.outstanding_amount_minor,
             fsc.status, fsc.synced_at, c.code AS currency, c.minor_unit AS currency_minor_unit
      FROM app.installment_cache AS fsc
      JOIN app.currencies AS c ON c.id = fsc.currency_id
      WHERE fsc.school_id = ${schoolId}::uuid AND fsc.student_id = ANY(${studentIds}::uuid[])
      ORDER BY fsc.due_date ASC, fsc.erpnext_fee_schedule_id
    `,
    tx<Record<string, unknown>[]>`
      SELECT pc.student_id, pc.id,
             pc.erpnext_docname, pc.erpnext_invoice_id,
             pc.amount_minor, pc.payment_mode, pc.status, pc.erpnext_status, pc.receipt_url,
             pc.payment_date::text AS payment_date, pc.confirmed_at, pc.last_synced_at,
             c.code AS currency, c.minor_unit AS currency_minor_unit
      FROM app.payment_cache AS pc
      JOIN app.currencies AS c ON c.id = pc.currency_id
      WHERE pc.school_id = ${schoolId}::uuid AND pc.student_id = ANY(${studentIds}::uuid[])
      ORDER BY pc.payment_date DESC, pc.erpnext_docname
    `,
  ]);

  const customerIdsByStudent = new Map<string, string[]>();
  for (const student of students) {
    customerIdsByStudent.set(student.id, [student.admission_number]);
  }

  const invoiceRows = invoices.map(parseInvoiceRow);
  const installmentRows = installments.map(parseInstallmentRow);
  const paymentRows = payments.map(parsePaymentRow);

  const householdTotals = new Map<string, TotalsEntry>();
  const sections: FamilyStudentSection[] = [];

  for (const studentId of studentIds) {
    const studentInvoices = invoiceRows.filter((row) => row.student_id === studentId);
    const studentInstallments = installmentRows.filter((row) => row.student_id === studentId);
    const studentPayments = paymentRows.filter((row) => row.student_id === studentId);

    const studentTotals = new Map<string, TotalsEntry>();
    for (const row of studentInvoices) {
      addTotals(
        studentTotals,
        row.currency,
        row.currency_minor_unit,
        row.total_amount_minor,
        row.total_amount_minor - row.outstanding_amount_minor,
        row.outstanding_amount_minor,
      );
    }
    for (const [currency, entry] of studentTotals) {
      addTotals(
        householdTotals,
        currency,
        entry.minorUnit,
        entry.total,
        entry.paid,
        entry.outstanding,
      );
    }

    sections.push({
      student_id: studentId,
      customer_ids: customerIdsByStudent.get(studentId) ?? [],
      invoices: studentInvoices.map((row) => toInvoiceSummary(row, payRedirectBaseUrl)),
      installments: studentInstallments.map(toInstallmentSummary),
      payments: studentPayments.map(toPaymentSummary),
      totals: [...studentTotals].map(([currency, entry]) => toCurrencyTotal(currency, entry)),
    });
  }

  const syncedTimes = [
    ...invoices.map((row) => row.last_synced_at as Date),
    ...installments.map((row) => row.synced_at as Date),
    ...payments.map((row) => row.last_synced_at as Date),
  ];
  const dataAsOf =
    syncedTimes.length > 0
      ? new Date(Math.max(...syncedTimes.map((d) => d.getTime()))).toISOString()
      : null;

  return {
    family_id: familyId,
    students: sections,
    household_totals: [...householdTotals].map(([currency, entry]) =>
      toCurrencyTotal(currency, entry),
    ),
    data_as_of: dataAsOf,
    reconciled_at: reconciledAt,
    presentation,
  };
}
