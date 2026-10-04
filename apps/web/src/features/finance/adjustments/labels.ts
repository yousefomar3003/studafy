import type { AwardStatus, ReasonCode, RefundStatus } from "./queries";
import type { ScholarshipDiscount } from "../fees/queries";
import type { TFunction } from "i18next";

// Translation keys (not display strings): resolved with `t()` at render time so the label follows
// the active locale instead of whatever locale was active when this module loaded.

export const AWARD_STATUS_LABEL_KEYS: Record<AwardStatus, string> = {
  pending: "financeReports.adjustments.awardStatus.pending",
  confirmed: "financeReports.adjustments.awardStatus.confirmed",
  cancelled: "financeReports.adjustments.awardStatus.cancelled",
};

/** `dashboard-tile__status-pill` tone for an award's maker-checker status, same tone convention
 * `payments/labels.ts`'s `paymentStatusTone` uses. */
export function awardStatusTone(status: AwardStatus): "success" | "warning" | "danger" {
  if (status === "confirmed") return "success";
  if (status === "cancelled") return "danger";
  return "warning";
}

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
  t: TFunction,
): string {
  const category =
    discount.scope === "fee_category" && discount.fee_category ? discount.fee_category : null;
  if (discount.discount_type === "fixed") {
    const amount = discount.currency
      ? `${discount.amount} ${discount.currency}`
      : `${discount.amount}`;
    return category
      ? t("financeReports.adjustments.discountEffect.fixedCategory", { amount, category })
      : t("financeReports.adjustments.discountEffect.fixedAll", { amount });
  }
  return category
    ? t("financeReports.adjustments.discountEffect.percentCategory", {
        amount: discount.amount,
        category,
      })
    : t("financeReports.adjustments.discountEffect.percentAll", { amount: discount.amount });
}
