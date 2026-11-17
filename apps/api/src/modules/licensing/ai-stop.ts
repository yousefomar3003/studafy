import { LICENSE_NONPAYMENT_GRACE_DAYS, licenseAiStopDate } from "@studafy/constants";

import type { TransactionSql } from "postgres";

/**
 * AI stops 30 days after an unpaid instalment (migration 000233). The workers' licence lifecycle job
 * suspends an active licence once any unpaid instalment of one of its open invoices is
 * LICENSE_NONPAYMENT_GRACE_DAYS past its due date, marking it `nonpayment_suspended_at`; this module tells
 * the school when the next cutoff is (nonpayment.ts resumes a licence once it is paid).
 */

const DAY_MS = 86_400_000;

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The unpaid instalments of a licence's open invoices that are past the cutoff on `now`'s date. */
export async function instalmentsPastCutoff(
  tx: TransactionSql,
  licenseId: string,
  now: Date,
): Promise<number> {
  const [row] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM app.license_invoice_instalments AS inst
    JOIN app.license_invoices AS i ON i.id = inst.invoice_id AND i.school_id = inst.school_id
    WHERE inst.school_id = current_setting('app.school_id')::uuid
      AND i.license_id = ${licenseId}::uuid
      AND i.status IN ('issued', 'partially_paid')
      AND inst.status <> 'paid'
      AND inst.due_date + ${LICENSE_NONPAYMENT_GRACE_DAYS}::int <= ${today(now)}::date
  `;
  return row?.count ?? 0;
}

/** The next time the licence's AI would stop: its earliest unpaid instalment's cutoff. */
export interface AiStopView {
  invoiceId: string;
  invoiceNumber: string;
  position: number;
  dueDate: string;
  /** YYYY-MM-DD (UTC): the AI stops on this day if the instalment is still unpaid. */
  stopDate: string;
  balanceMinor: number;
  currencyCode: string;
  minorUnit: number;
  /** Whole days from today to `stopDate`; 0 or less once it has passed. */
  daysLeft: number;
}

export async function nextAiStop(
  tx: TransactionSql,
  licenseId: string,
  now: Date = new Date(),
): Promise<AiStopView | null> {
  const [row] = await tx<
    {
      invoice_id: string;
      number: string;
      position: number;
      due_date: string;
      balance_minor: string;
      currency_code: string;
      minor_unit: number;
    }[]
  >`
    SELECT i.id::text AS invoice_id, i.number, inst.position, inst.due_date::text AS due_date,
           inst.balance_minor::text AS balance_minor, c.code AS currency_code,
           c.minor_unit::int AS minor_unit
    FROM app.license_invoice_instalments AS inst
    JOIN app.license_invoices AS i ON i.id = inst.invoice_id AND i.school_id = inst.school_id
    JOIN app.currencies AS c ON c.id = i.currency_id
    WHERE inst.school_id = current_setting('app.school_id')::uuid
      AND i.license_id = ${licenseId}::uuid
      AND i.status IN ('issued', 'partially_paid')
      AND inst.status <> 'paid'
    ORDER BY inst.due_date, i.number, inst.position
    LIMIT 1
  `;
  if (!row) return null;
  const stopDate = licenseAiStopDate(row.due_date);
  return {
    invoiceId: row.invoice_id,
    invoiceNumber: row.number,
    position: row.position,
    dueDate: row.due_date,
    stopDate,
    balanceMinor: Number(row.balance_minor),
    currencyCode: row.currency_code,
    minorUnit: row.minor_unit,
    daysLeft: Math.round(
      (Date.parse(`${stopDate}T00:00:00Z`) - Date.parse(`${today(now)}T00:00:00Z`)) / DAY_MS,
    ),
  };
}
