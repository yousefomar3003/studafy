import { api } from "../../../lib/api";

import type { Payment } from "../queries";
import type { components } from "@studafy/api-client";

export type { Payment } from "../queries";
export type CreatePaymentBody = components["schemas"]["CreatePaymentBody"];
// The generated `PaymentMode` schema type carries a spurious `| null` — a pre-existing
// `@studafy/api-client` generator quirk (the same family of gap `NotificationBell.tsx` documents
// for `readonly` arrays): `paymentModeSchema` is reused `.nullable()` inside `paymentSchema`, and
// the generator folds that nullability into the shared named schema instead of only that field.
// `createPaymentBodySchema`'s own `payment_mode` is never actually nullable, so this form's own
// state and `<Radio>` values use the non-null type directly rather than propagating the gap.
export type PaymentMode = Exclude<components["schemas"]["PaymentMode"], null>;
export type PaymentStatus = Payment["status"];

const PAGE_SIZE = 20;

export interface PaymentFilters {
  /** `""` means "every status" — left off the request rather than sent empty, same convention
   * `invoices/queries.ts`'s `InvoiceFilters` documents. */
  status: PaymentStatus | "";
}

export interface PaymentsPage {
  items: Payment[];
  total: number;
}

/**
 * One page of `GET /api/finance/payments`. Offset-based, not cursor-based: unlike
 * `invoices/queries.ts`'s `fetchInvoicesPage`, the payments endpoint's own query contract
 * (`paymentQuerySchema`) only takes `limit`/`offset`, so `PaymentsListPage` paginates on those
 * directly rather than routing through `@studafy/ui`'s cursor-shaped `useCursorPagination`.
 */
export async function fetchPaymentsPage(
  filters: PaymentFilters,
  offset: number,
): Promise<PaymentsPage> {
  const { data } = await api.GET("/api/finance/payments", {
    params: {
      query: {
        limit: PAGE_SIZE,
        offset,
        status: (filters.status || undefined) as PaymentStatus | undefined,
      },
    },
  });
  // `readonly Payment[]` loses its array prototype through the generated response type here — the
  // same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents for
  // `notifications`.
  return {
    items: (data?.payments ?? []) as Payment[],
    total: data?.total ?? 0,
  };
}

export const PAYMENTS_PAGE_SIZE = PAGE_SIZE;

export function paymentQueryKey(paymentId: string) {
  return ["finance", "payments", paymentId] as const;
}

export async function fetchPayment(paymentId: string): Promise<Payment> {
  const { data } = await api.GET("/api/finance/payments/{paymentId}", {
    params: { path: { paymentId } },
  });
  if (!data) throw new Error("Payment not found.");
  return data as Payment;
}
