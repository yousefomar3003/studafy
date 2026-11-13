import { useMutation } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { CreatePaymentBody, Payment } from "./queries";

export interface CreatePaymentInput {
  body: CreatePaymentBody;
  /**
   * Caller-supplied `Idempotency-Key`. Deliberately not generated inside this hook: the same key
   * must be reused across a retry of the *same* submission attempt (including a double-click that
   * fires two calls before `isPending` disables the button — see `PaymentForm`'s `submittingRef`),
   * while a genuinely new attempt needs a fresh one. That lifetime belongs to the form, not the
   * mutation.
   */
  idempotencyKey: string;
}

/** Records a payment against an invoice. The response is `status: "pending"` until ERPNext's
 * webhook confirms it — `RecordPaymentPage`'s success state polls `fetchPayment` for that. */
export function useCreatePayment() {
  return useMutation({
    mutationFn: async ({ body, idempotencyKey }: CreatePaymentInput) => {
      const { data } = await api.POST("/api/finance/payments", {
        params: { header: { "idempotency-key": idempotencyKey } },
        body,
      });
      if (!data) throw new Error("Payment creation returned no data.");
      return data as Payment;
    },
  });
}
