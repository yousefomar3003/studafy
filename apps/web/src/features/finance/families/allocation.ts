/**
 * The family payment split, as the form previews it. Mirrors `allocateOldestFirst` in
 * `apps/api/src/modules/finance/family-accounts/service.ts`: pay the oldest-due invoice first, then
 * the next, until the amount runs out. The server applies the same rule when the form sends no
 * split of its own, and validates any split it does send, so this is a preview, not the authority.
 *
 * Everything is in integer minor units: JOD has 3 decimals and floating point would drift.
 */

export interface OpenInvoice {
  invoice_id: string;
  student_id: string;
  due_date: string | null;
  issued_date: string;
  outstanding_minor: number;
}

export interface Allocation {
  invoice_id: string;
  amount_minor: number;
}

/** Oldest due first; invoices without a due date last; then by issue date and number. */
export function payingOrder(invoices: readonly OpenInvoice[]): OpenInvoice[] {
  return [...invoices].sort((a, b) => {
    if (a.due_date !== b.due_date) {
      if (a.due_date === null) return 1;
      if (b.due_date === null) return -1;
      return a.due_date < b.due_date ? -1 : 1;
    }
    if (a.issued_date !== b.issued_date) return a.issued_date < b.issued_date ? -1 : 1;
    return a.invoice_id < b.invoice_id ? -1 : 1;
  });
}

export function allocateOldestFirst(
  amountMinor: number,
  invoices: readonly OpenInvoice[],
): Allocation[] {
  const plan: Allocation[] = [];
  let remaining = amountMinor;
  for (const invoice of payingOrder(invoices)) {
    if (remaining <= 0) break;
    const share = Math.min(remaining, invoice.outstanding_minor);
    if (share <= 0) continue;
    plan.push({ invoice_id: invoice.invoice_id, amount_minor: share });
    remaining -= share;
  }
  return plan;
}

/** Decimal text ("12.5") to minor units, or null when it is not a usable positive amount. */
export function toMinor(text: string, minorUnit: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > minorUnit) return null;
  return Number(whole) * 10 ** minorUnit + Number(fraction.padEnd(minorUnit, "0") || "0");
}

/** Minor units back to fixed decimal text at the currency's precision. */
export function fromMinor(minor: number, minorUnit: number): string {
  if (minorUnit === 0) return String(minor);
  const digits = String(Math.abs(minor)).padStart(minorUnit + 1, "0");
  const sign = minor < 0 ? "-" : "";
  return `${sign}${digits.slice(0, -minorUnit)}.${digits.slice(-minorUnit)}`;
}
