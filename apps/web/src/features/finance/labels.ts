import type { Payment } from "./queries";

type PaymentMode = NonNullable<Payment["payment_mode"]>;
type PaymentStatus = Payment["status"];

/** Translation keys (resolved with `t` at render time) for each payment mode. */
export const PAYMENT_MODE_LABEL_KEYS: Record<PaymentMode, string> = {
  cash: "finance.paymentMode.cash",
  bank_transfer: "finance.paymentMode.bank_transfer",
  card_external: "finance.paymentMode.card_external",
};

/** Translation keys (resolved with `t` at render time) for each payment status. */
export const PAYMENT_STATUS_LABEL_KEYS: Record<PaymentStatus, string> = {
  pending: "finance.paymentStatus.pending",
  confirmed: "finance.paymentStatus.confirmed",
  failed: "finance.paymentStatus.failed",
};

/** `dashboard-tile__status-pill` tone for a payment's ERPNext confirmation status. */
export function paymentStatusTone(status: PaymentStatus): "success" | "warning" | "danger" {
  if (status === "confirmed") return "success";
  if (status === "failed") return "danger";
  return "warning";
}
