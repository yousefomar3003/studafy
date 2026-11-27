/** Where a payment's receipt is served. Relative to the API origin, which every client holds. */
export function receiptPath(paymentId: string): string {
  return `/api/finance/payments/${encodeURIComponent(paymentId)}/receipt`;
}

/**
 * The receipt link a payment response carries: confirmed payments only, so a client offers a
 * receipt once the money is settled. It points at Studafy's own receipt (receipts/routes.ts), not
 * ERPNext's print view, which neither the web app nor the parent app can authenticate to.
 */
export function receiptUrlFor(payment: { id: string; status: string }): string | null {
  return payment.status === "confirmed" ? receiptPath(payment.id) : null;
}

/** Where a refund's receipt is served: a refund handed back to the family has one. */
export function refundReceiptPath(refundId: string): string {
  return `/api/finance/refunds/${encodeURIComponent(refundId)}/receipt`;
}

/** The receipt link a refund response carries: only once money was handed back to the family. */
export function refundReceiptUrlFor(refund: {
  id: string;
  kind: string;
  status: string;
  settlement: string;
}): string | null {
  return refund.kind === "credit_note" &&
    refund.status === "completed" &&
    refund.settlement === "paid_out"
    ? refundReceiptPath(refund.id)
    : null;
}
