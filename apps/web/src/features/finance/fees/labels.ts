import type { FeeStructure } from "./queries";
import type { TFunction } from "i18next";

/** `erpnext_status` is a free-form string on the wire (`statusFromDocstatus` in the gateway's
 * `service.ts` only ever emits these three), not a closed enum — an unrecognized value falls back
 * to itself rather than throwing, so a future ERPNext status still renders instead of breaking the
 * page. */
const KNOWN_STATUS_LABEL_KEYS: Record<string, string> = {
  draft: "finance.docStatus.draft",
  submitted: "finance.docStatus.submitted",
  cancelled: "finance.docStatus.cancelled",
};

export function feeStructureStatusLabel(
  status: FeeStructure["erpnext_status"],
  t: TFunction,
): string {
  // A lookup into a small fixed local object for display text, not a property/path access driven
  // by untrusted input — the same bounded-key shape `finance/queries.ts` documents for this rule.
  // eslint-disable-next-line security/detect-object-injection
  const key = KNOWN_STATUS_LABEL_KEYS[status];
  return key ? t(key) : status;
}

/** `fee-builder__status-pill` tone — submitted/cancelled are both immutable in ERPNext (see
 * `updateFeeStructure`'s doc comment in the gateway's `service.ts`), so only `draft` reads as the
 * "still editable" state. */
export function feeStructureStatusTone(
  status: FeeStructure["erpnext_status"],
): "success" | "warning" | "neutral" {
  if (status === "draft") return "warning";
  if (status === "submitted") return "success";
  return "neutral";
}
