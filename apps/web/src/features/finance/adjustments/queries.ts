import { api } from "../../../lib/api";

import type { ScholarshipDiscount } from "../fees/queries";
import type { components } from "@studafy/api-client";

export type Award = components["schemas"]["Award"];
export type AwardStatus = Award["award_status"];
export type Refund = components["schemas"]["Refund"];
export type RefundStatus = Refund["status"];
export type ReasonCode = Refund["reason_code"];
export type CreateAwardBody = components["schemas"]["CreateAwardBody"];
export type InitiateRefundBody = components["schemas"]["InitiateRefundBody"];
export type { ScholarshipDiscount } from "../fees/queries";

/** A decimal amount at `minorUnit` precision, formatted the same way `RecordPaymentPage`'s
 * `formatMinorAmount` formats a payment's remaining balance. */
export function formatMinorAmount(minor: number, minorUnit: number): string {
  return (minor / 10 ** minorUnit).toFixed(minorUnit);
}

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Scholarship/discount awards
// ---------------------------------------------------------------------------

export interface AwardFilters {
  /** `""` means "every status" — left off the request rather than sent empty, matching
   * `payments/queries.ts`'s `PaymentFilters`. */
  status: AwardStatus | "";
}

export interface AwardsPage {
  items: Award[];
  total: number;
}

export async function fetchAwardsPage(filters: AwardFilters, offset: number): Promise<AwardsPage> {
  const { data } = await api.GET("/api/finance/scholarship-discounts/awards", {
    params: {
      query: {
        limit: PAGE_SIZE,
        offset,
        status: (filters.status || undefined) as AwardStatus | undefined,
      },
    },
  });
  // `readonly Award[]` loses its array prototype through the generated response type here — the
  // same pre-existing `@studafy/api-client` typing gap `finance/queries.ts` documents for `Payment[]`.
  return { items: (data?.awards ?? []) as Award[], total: data?.total ?? 0 };
}

export const AWARDS_PAGE_SIZE = PAGE_SIZE;

/**
 * Every scholarship/discount config, active or not — unlike `fees/queries.ts`'s own
 * `fetchScholarshipDiscounts` (which the "award this" picker uses and deliberately narrows to
 * `is_active: "true"`), an award already on the books can reference a since-deactivated config, and
 * the confirmation dialog still needs that config's terms to show what the award actually grants.
 * Kept local rather than shared, same reasoning `fees/queries.ts`'s own `fetchAllOffsetPages` gives
 * for its copy: each feature folder owns its own data-fetching file.
 */
const MAX_PAGES = 20;

export async function fetchAllScholarshipDiscounts(): Promise<ScholarshipDiscount[]> {
  const rows: ScholarshipDiscount[] = [];
  const pageSize = 100;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data } = await api.GET("/api/finance/scholarship-discounts", {
      params: { query: { limit: pageSize, offset: page * pageSize } },
    });
    const batch = (data?.scholarship_discounts ?? []) as ScholarshipDiscount[];
    rows.push(...batch);
    if (batch.length < pageSize || rows.length >= (data?.total ?? 0)) break;
  }
  return rows;
}

export const SCHOLARSHIP_DISCOUNTS_ALL_KEY = [
  "finance",
  "adjustments",
  "scholarship-discounts",
  "all",
] as const;

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
