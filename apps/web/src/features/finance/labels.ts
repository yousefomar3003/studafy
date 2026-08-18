import type { Payment } from "./queries";

type PaymentMode = NonNullable<Payment["payment_mode"]>;
type PaymentStatus = Payment["status"];

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  card_external: "Card (external)",
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  failed: "Failed",
};

/** `dashboard-tile__status-pill` tone for a payment's ERPNext confirmation status. */
export function paymentStatusTone(status: PaymentStatus): "success" | "warning" | "danger" {
  if (status === "confirmed") return "success";
  if (status === "failed") return "danger";
  return "warning";
}
