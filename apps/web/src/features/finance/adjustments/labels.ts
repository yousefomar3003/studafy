import type { ReasonCode, RefundStatus } from "./queries";

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
};
