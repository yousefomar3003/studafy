/**
 * Client-side invoice preview for a fee structure being built.
 *
 * There is no server-side "dry run" endpoint: `POST /api/finance/fee-structures` always writes a
 * real ERPNext draft, and `generateFeeSchedule` always writes real installments. Rather than fake a
 * preview endpoint that doesn't exist, this reproduces what the actual invoice generator computes —
 * see `generateInvoice` in `apps/workers/src/queues/billing/invoice.service.ts` — against the
 * components the admin is currently editing. Without a student the invoice is exactly the
 * structure's components; with one, their approved scholarships come off it the way
 * `apps/workers/src/queues/billing/scholarship-discount.ts` takes them off a real invoice.
 */

export interface FeeComponentDraft {
  fee_category: string;
  amount: number;
  description?: string;
}

export interface InvoicePreviewLine {
  feeCategory: string;
  amount: number;
}

export interface InvoicePreview {
  lineItems: InvoicePreviewLine[];
  total: number;
}

export function componentsSubtotal(components: readonly FeeComponentDraft[]): number {
  return components.reduce(
    (sum, component) => sum + (Number.isFinite(component.amount) ? component.amount : 0),
    0,
  );
}

export function buildInvoicePreview(components: readonly FeeComponentDraft[]): InvoicePreview {
  return {
    lineItems: components.map((component) => ({
      feeCategory: component.fee_category,
      amount: component.amount,
    })),
    total: componentsSubtotal(components),
  };
}

export interface PreviewScholarship {
  discount_type: "percentage" | "fixed";
  /** Decimal string, e.g. "12.50"; null for fixed. */
  percentage: string | null;
  /** Decimal string in `currency`; null for percentage. */
  amount: string | null;
  currency: string | null;
  fee_category: string | null;
}

/** Amounts are previewed at three decimals, the precision ERPNext amounts are shown with. */
const MINOR_DIGITS = 3;
const toMinor = (amount: number) => Math.round(amount * 10 ** MINOR_DIGITS);

/**
 * The discount `scholarships` take off this structure's invoice: each covers every line or only its
 * fee category; a percentage rounds half up; a fixed amount is capped at what it covers and skipped
 * in another currency; together they never exceed the subtotal. Same rules as the billing worker.
 */
export function scholarshipDiscount(
  components: readonly FeeComponentDraft[],
  scholarships: readonly PreviewScholarship[],
  currency: string,
): number {
  const lines = components.map((c) => ({ category: c.fee_category, minor: toMinor(c.amount) }));
  const subtotal = lines.reduce((sum, line) => sum + line.minor, 0);
  if (subtotal <= 0) return 0;

  let discount = 0;
  for (const scholarship of scholarships) {
    const covered = lines
      .filter((line) => !scholarship.fee_category || line.category === scholarship.fee_category)
      .reduce((sum, line) => sum + line.minor, 0);
    if (covered <= 0) continue;
    if (scholarship.discount_type === "percentage" && scholarship.percentage !== null) {
      const basisPoints = Math.round(Number(scholarship.percentage) * 100);
      discount += Math.floor((covered * basisPoints + 5000) / 10000);
    } else if (
      scholarship.discount_type === "fixed" &&
      scholarship.amount !== null &&
      scholarship.currency === currency
    ) {
      discount += Math.min(toMinor(Number(scholarship.amount)), covered);
    }
  }
  return Math.min(discount, subtotal) / 10 ** MINOR_DIGITS;
}
