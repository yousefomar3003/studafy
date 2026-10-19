/**
 * Client-side invoice preview for a fee structure being built.
 *
 * There is no server-side "dry run" endpoint: `POST /api/finance/fee-structures` always writes a
 * real ERPNext draft, and `generateFeeSchedule` always writes real installments. Rather than fake a
 * preview endpoint that doesn't exist, this reproduces what the actual invoice generator computes —
 * see `generateInvoice` in `apps/workers/src/queues/billing/invoice.service.ts` — against the
 * components the admin is currently editing. Scholarships and discounts are switched off, so an
 * invoice is exactly the structure's components and every student's invoice is the same.
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
