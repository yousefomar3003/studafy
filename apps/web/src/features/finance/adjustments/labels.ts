import type { PayoutMode, ReasonCode, RefundKind, RefundSettlement, RefundStatus } from "./queries";

// Translation keys (not display strings): resolved with `t()` at render time so the label follows
// the active locale instead of whatever locale was active when this module loaded.

export const REFUND_STATUS_LABEL_KEYS: Record<RefundStatus, string> = {
  pending_approval: "financeReports.adjustments.refundStatus.pending_approval",
  approved: "financeReports.adjustments.refundStatus.approved",
  rejected: "financeReports.adjustments.refundStatus.rejected",
  submitted_to_erpnext: "financeReports.adjustments.refundStatus.submitted_to_erpnext",
  completed: "financeReports.adjustments.refundStatus.completed",
  failed: "financeReports.adjustments.refundStatus.failed",
};

export function refundStatusTone(status: RefundStatus): "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (status === "rejected" || status === "failed") return "danger";
  return "warning";
}

export const REASON_CODE_LABEL_KEYS: Record<ReasonCode, string> = {
  overpayment: "financeReports.adjustments.reasonCode.overpayment",
  withdrawal: "financeReports.adjustments.reasonCode.withdrawal",
  discount_adjustment: "financeReports.adjustments.reasonCode.discount_adjustment",
  error_correction: "financeReports.adjustments.reasonCode.error_correction",
  write_off: "financeReports.adjustments.reasonCode.write_off",
};

export const REFUND_KIND_LABEL_KEYS: Record<RefundKind, string> = {
  credit_note: "financeReports.adjustments.refundKind.credit_note",
  invoice_cancellation: "financeReports.adjustments.refundKind.invoice_cancellation",
  payment_reversal: "financeReports.adjustments.refundKind.payment_reversal",
};

/** What approving a request of this kind does, for the approve dialog. */
export const REFUND_KIND_EFFECT_KEYS: Record<RefundKind, string> = {
  credit_note: "financeReports.adjustments.refunds.approveDescription",
  invoice_cancellation: "financeReports.adjustments.corrections.approveCancellation",
  payment_reversal: "financeReports.adjustments.corrections.approveReversal",
};

/** How the money a refund gives back reaches the family (000271). */
export const PAYOUT_MODE_LABEL_KEYS: Record<PayoutMode, string> = {
  cash: "financeReports.adjustments.payoutMode.cash",
  bank_transfer: "financeReports.adjustments.payoutMode.bank_transfer",
  card_external: "financeReports.adjustments.payoutMode.card_external",
  credit: "financeReports.adjustments.payoutMode.credit",
};

/** What an approved refund did, worded with the amount and payout mode (see RefundDetailPage). */
export const SETTLEMENT_LABEL_KEYS: Record<Exclude<RefundSettlement, "pending">, string> = {
  invoice: "financeReports.adjustments.settlement.invoice",
  paid_out: "financeReports.adjustments.settlement.paid_out",
  family_credit: "financeReports.adjustments.settlement.family_credit",
};
