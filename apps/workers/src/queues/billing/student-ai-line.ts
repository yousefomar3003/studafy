/**
 * The Student AI line on generated invoices (phase 3 of the AI revenue-share programme, 000238).
 *
 * The API's reconciliation (`syncStudentAiFeeItems`) spreads each opted-in student's Student AI
 * line over their tuition instalments as planned portions. When this worker generates a Sales
 * Invoice for the student, every planned portion due on or before the invoice's due date (its
 * posting date when it has none) goes on the invoice as its own "Student AI" item -- qty the months
 * it pays for, rate the monthly price -- and is then marked invoiced with the invoice's name, which
 * freezes it. So ERPNext's totals, ledger and outstanding amount carry the line, and a portion is
 * never billed twice: the claim locks the rows, and a second invoice generated meanwhile finds them
 * invoiced.
 *
 * A portion in another currency than the invoice is left planned (no conversion is ever guessed),
 * as is a zero-amount portion. Scholarship and sibling discounts are computed on the fee
 * structure's own components, so they never reduce the Student AI line; sales tax, when the school
 * charges it, applies to it like any other line unless "Student AI" is an exempt category.
 */

import type { ErpNextClient } from "./erpnext-client";
import type { SalesInvoiceItem } from "./sales-tax";
import type { TransactionSql } from "postgres";

/** The ERPNext Fee Category (and so Item code) the line is billed under. */
export const STUDENT_AI_FEE_CATEGORY = "Student AI";

export interface PlannedStudentAiPortion {
  id: string;
  amount_minor: bigint;
  currency_code: string;
  minor_unit: number;
  /** ISO date, first day of the first month paid. */
  first_month: string;
  month_count: number;
}

/** A student's planned portions due on or before `dueBy`, locked until the transaction ends. */
export async function claimStudentAiPortions(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  dueBy: string,
): Promise<PlannedStudentAiPortion[]> {
  const rows = await tx<
    {
      id: string;
      amount_minor: string;
      currency_code: string;
      minor_unit: number;
      first_month: string;
      month_count: number;
    }[]
  >`
    SELECT p.id, p.amount_minor::text AS amount_minor, c.code AS currency_code, c.minor_unit,
           p.first_month::text AS first_month, p.month_count
    FROM app.student_ai_fee_portions AS p
    JOIN app.student_ai_fee_items AS item ON item.id = p.item_id AND item.school_id = p.school_id
    JOIN app.currencies AS c ON c.id = item.currency_id
    WHERE p.school_id = ${schoolId}::uuid
      AND p.student_id = ${studentId}::uuid
      AND p.status = 'planned'
      AND p.due_date <= ${dueBy}::date
      AND item.billing = 'auto'
    ORDER BY p.due_date, p.first_month
    FOR UPDATE OF p
  `;
  return rows.map((row) => ({ ...row, amount_minor: BigInt(row.amount_minor) }));
}

function monthLabel(firstMonth: string, offset: number): string {
  const [year, month] = firstMonth.split("-").map(Number) as [number, number];
  const index = year * 12 + (month - 1) + offset;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/**
 * The invoice items for the claimed portions in the invoice's currency, and the portions they bill.
 * Null when there is nothing to add.
 */
export function studentAiInvoiceItems(
  portions: readonly PlannedStudentAiPortion[],
  invoiceCurrencyCode: string,
): { items: SalesInvoiceItem[]; portionIds: string[] } | null {
  const billable = portions.filter(
    (portion) =>
      portion.currency_code === invoiceCurrencyCode.toUpperCase() && portion.amount_minor > 0n,
  );
  if (billable.length === 0) return null;
  return {
    items: billable.map((portion) => {
      const scale = 10 ** portion.minor_unit;
      const months = portion.month_count;
      const from = monthLabel(portion.first_month, 0);
      const to = monthLabel(portion.first_month, months - 1);
      return {
        item_code: STUDENT_AI_FEE_CATEGORY,
        qty: months,
        // Exact: a portion is always the monthly price times its months.
        rate: Number(portion.amount_minor / BigInt(months)) / scale,
        description: months === 1 ? `Student AI ${from}` : `Student AI ${from} to ${to}`,
      };
    }),
    portionIds: billable.map((portion) => portion.id),
  };
}

/** Freeze the portions an invoice now carries. */
export async function markStudentAiPortionsInvoiced(
  tx: TransactionSql,
  schoolId: string,
  portionIds: readonly string[],
  invoiceDocname: string,
): Promise<void> {
  if (portionIds.length === 0) return;
  await tx`
    UPDATE app.student_ai_fee_portions
    SET status = 'invoiced', erpnext_invoice_docname = ${invoiceDocname},
        invoiced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND id = ANY(${[...portionIds]}::uuid[])
      AND status = 'planned'
  `;
}

/**
 * Make sure the school's ERPNext site has the "Student AI" Fee Category (ERPNext creates the Item
 * of the same name with it), so the invoice item resolves. Idempotent: an existing category, or one
 * created concurrently, is fine.
 */
export async function ensureStudentAiFeeCategory(client: ErpNextClient): Promise<void> {
  const path = `/api/resource/Fee%20Category/${encodeURIComponent(STUDENT_AI_FEE_CATEGORY)}`;
  try {
    await client.get(path);
    return;
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
  try {
    await client.post("/api/resource/Fee%20Category", {
      category_name: STUDENT_AI_FEE_CATEGORY,
      description: "Student AI, billed with tuition",
    });
  } catch (error) {
    // 409: another invoice created it first.
    if ((error as { status?: number }).status !== 409) throw error;
  }
}
