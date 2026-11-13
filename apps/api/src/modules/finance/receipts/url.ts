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
