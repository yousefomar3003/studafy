import type { AwardStatus, ReasonCode, RefundStatus } from "./queries";
import type { ScholarshipDiscount } from "../fees/queries";

export const AWARD_STATUS_LABELS: Record<AwardStatus, string> = {
  pending: "Pending confirmation",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
};

/** `dashboard-tile__status-pill` tone for an award's maker-checker status, same tone convention
 * `payments/labels.ts`'s `paymentStatusTone` uses. */
export function awardStatusTone(status: AwardStatus): "success" | "warning" | "danger" {
  if (status === "confirmed") return "success";
  if (status === "cancelled") return "danger";
  return "warning";
}

export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
  pending_approval: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
  submitted_to_erpnext: "Submitted to ERPNext",
  completed: "Completed",
  failed: "Failed",
};

export function refundStatusTone(status: RefundStatus): "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (status === "rejected" || status === "failed") return "danger";
  return "warning";
}

export const REASON_CODE_LABELS: Record<ReasonCode, string> = {
  overpayment: "Overpayment",
  withdrawal: "Withdrawal",
  discount_adjustment: "Discount adjustment",
  error_correction: "Error correction",
};

/**
 * What awarding `discount` actually grants, in its own defined terms — shared by the maker step's
 * (`NewScholarshipAwardPage`) and checker step's (`ScholarshipAwardsListPage`) confirmation dialogs.
 * Deliberately not a projection onto some future invoice: nothing is invoiced yet at either
 * confirmation step, so the discount's own terms are the only exact effect knowable right now.
 */
export function discountEffectLine(
  discount: Pick<
    ScholarshipDiscount,
    "discount_type" | "amount" | "currency" | "scope" | "fee_category"
  >,
): string {
  const scope =
    discount.scope === "fee_category" && discount.fee_category
      ? `the "${discount.fee_category}" fee category`
      : "all fee categories";
  if (discount.discount_type === "fixed") {
    const amount = discount.currency
      ? `${discount.amount} ${discount.currency}`
      : `${discount.amount}`;
    return `${amount} off ${scope} on every future invoice.`;
  }
  return `${discount.amount}% off ${scope} on every future invoice.`;
}
