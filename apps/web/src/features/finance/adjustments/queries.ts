import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type Refund = components["schemas"]["Refund"];
export type RefundStatus = Refund["status"];
export type ReasonCode = Refund["reason_code"];
export type InitiateRefundBody = components["schemas"]["InitiateRefundBody"];

/** A decimal amount at `minorUnit` precision, formatted the same way `RecordPaymentPage`'s
 * `formatMinorAmount` formats a payment's remaining balance. */
export function formatMinorAmount(minor: number, minorUnit: number): string {
  return (minor / 10 ** minorUnit).toFixed(minorUnit);
}

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export interface RefundFilters {
  status: RefundStatus | "";
}

export interface RefundsPage {
  items: Refund[];
  total: number;
}

export async function fetchRefundsPage(
  filters: RefundFilters,
  offset: number,
): Promise<RefundsPage> {
  const { data } = await api.GET("/api/finance/refunds", {
    params: {
      query: {
        limit: PAGE_SIZE,
        offset,
        status: (filters.status || undefined) as RefundStatus | undefined,
      },
    },
  });
  return { items: (data?.refunds ?? []) as Refund[], total: data?.total ?? 0 };
}

export const REFUNDS_PAGE_SIZE = PAGE_SIZE;

/** The invoice's net paid amount, in minor units: what a refund's amount is capped against. There
 * is no direct `paid_amount` field on `Invoice` (see `refunds/schemas.ts`'s own description of the
 * cap ERPNext enforces) — total minus outstanding is the same number ERPNext itself derives, so this
 * mirrors it rather than approximating. */
export function invoicePaidAmountMinor(invoice: {
  total_amount_minor: number;
  outstanding_amount_minor: number;
}): number {
  return invoice.total_amount_minor - invoice.outstanding_amount_minor;
}
