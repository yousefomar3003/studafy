/**
 * The discount a student's approved scholarships take off one invoice, in the invoice currency's
 * minor units. The caller hands it to ERPNext as the Sales Invoice's own `discount_amount`, so
 * ERPNext's totals, GL entries and outstanding amount all include it.
 *
 * - A scholarship covers every line, or only the lines of its `fee_category`.
 * - `percentage` takes that share of the covered lines, rounded half up to the minor unit.
 * - `fixed` takes its amount, capped at the covered lines. It is skipped when its currency is not
 *   the invoice's: converting at some rate would be a decision nobody approved.
 * - Several scholarships add up, and the total is capped at the invoice subtotal, so an invoice is
 *   never negative.
 */

export interface DiscountLine {
  fee_category: string;
  amount_minor: bigint;
}

export interface ApprovedScholarship {
  discount_type: "percentage" | "fixed";
  /** Decimal string as stored, e.g. "12.50"; null for fixed. */
  percentage: string | null;
  amount_minor: bigint | null;
  currency_code: string | null;
  fee_category: string | null;
}

/** "12.5" -> 1250 (hundredths of a percent); the column is numeric(5, 2). */
function basisPoints(percentage: string): bigint {
  const [whole = "0", fraction = ""] = percentage.trim().split(".");
  return BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
}

export function scholarshipDiscountMinor(
  lines: readonly DiscountLine[],
  scholarships: readonly ApprovedScholarship[],
  invoiceCurrencyCode: string,
): bigint {
  const subtotal = lines.reduce((sum, line) => sum + line.amount_minor, 0n);
  if (subtotal <= 0n) return 0n;

  let discount = 0n;
  for (const scholarship of scholarships) {
    const covered = lines
      .filter((line) => !scholarship.fee_category || line.fee_category === scholarship.fee_category)
      .reduce((sum, line) => sum + line.amount_minor, 0n);
    if (covered <= 0n) continue;

    if (scholarship.discount_type === "percentage" && scholarship.percentage !== null) {
      // covered * bp / 10000, rounded half up.
      discount += (covered * basisPoints(scholarship.percentage) + 5000n) / 10000n;
    } else if (
      scholarship.discount_type === "fixed" &&
      scholarship.amount_minor !== null &&
      scholarship.currency_code === invoiceCurrencyCode
    ) {
      discount += scholarship.amount_minor < covered ? scholarship.amount_minor : covered;
    }
  }

  return discount < subtotal ? discount : subtotal;
}
