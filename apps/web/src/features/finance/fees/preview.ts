/**
 * Client-side invoice preview for a fee structure being built.
 *
 * There is no server-side "dry run" endpoint: `POST /api/finance/fee-structures` always writes a
 * real ERPNext draft, and `generateFeeSchedule` always writes real installments. Rather than fake a
 * preview endpoint that doesn't exist, this reproduces the one computation the actual invoice
 * generator runs — see `generateInvoice` in `apps/workers/src/queues/billing/invoice.service.ts` —
 * against the components the admin is currently editing.
 *
 * It deliberately matches that worker's behaviour exactly, including a quirk worth naming: the
 * worker applies every confirmed award's discount to the whole invoice regardless of the discount
 * config's own `scope` ("global" vs "fee_category") — it does not restrict a `fee_category`-scoped
 * discount to that one line. Filtering by scope here would make this preview more correct than the
 * system it's previewing, which is worse than matching it: the acceptance criterion is "preview
 * matches generated invoice output," not "preview matches what invoice output should be."
 */

export interface FeeComponentDraft {
  fee_category: string;
  amount: number;
  description?: string;
}

export interface PreviewAward {
  scholarship_discount_id: string;
}

export interface PreviewDiscountConfig {
  id: string;
  discount_type: "percentage" | "fixed";
  amount: number;
}

export interface InvoicePreviewLine {
  feeCategory: string;
  amount: number;
}

export interface InvoicePreview {
  lineItems: InvoicePreviewLine[];
  subtotal: number;
  discountAmount: number;
  total: number;
}

export function componentsSubtotal(components: readonly FeeComponentDraft[]): number {
  return components.reduce(
    (sum, component) => sum + (Number.isFinite(component.amount) ? component.amount : 0),
    0,
  );
}

/** Mirrors `generateInvoice`'s discount loop: fixed amounts sum directly, percentages sum first and
 * apply once to the subtotal — two 10% awards discount 20%, not 19% compounded. */
export function buildInvoicePreview(
  components: readonly FeeComponentDraft[],
  confirmedAwards: readonly PreviewAward[],
  discountConfigs: readonly PreviewDiscountConfig[],
): InvoicePreview {
  const subtotal = componentsSubtotal(components);
  const configById = new Map(discountConfigs.map((config) => [config.id, config]));

  let discountAmount = 0;
  const percentageAwards: number[] = [];

  for (const award of confirmedAwards) {
    const config = configById.get(award.scholarship_discount_id);
    if (!config) continue;
    if (config.discount_type === "fixed") {
      discountAmount += config.amount;
    } else {
      percentageAwards.push(config.amount);
    }
  }

  if (percentageAwards.length > 0) {
    const combinedPercentage = percentageAwards.reduce((sum, pct) => sum + pct, 0);
    discountAmount += subtotal * (combinedPercentage / 100);
  }
  // Matches the worker's own rounding before it hands `discount_amount` to ERPNext.
  discountAmount = Math.round(discountAmount * 100) / 100;

  return {
    lineItems: components.map((component) => ({
      feeCategory: component.fee_category,
      amount: component.amount,
    })),
    subtotal,
    discountAmount,
    // Clamped for display only — ERPNext's own total is the real number once an invoice exists.
    total: Math.max(0, subtotal - discountAmount),
  };
}
