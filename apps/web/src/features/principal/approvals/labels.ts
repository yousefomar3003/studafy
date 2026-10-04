import type { PendingItemType } from "./queries";

/** Translation keys — resolve with `t(...)` at render time. */
export const ITEM_TYPE_LABEL_KEYS: Record<PendingItemType, string> = {
  grade_submission: "principal.approvals.itemType.grade_submission",
  timetable_version: "principal.approvals.itemType.timetable_version",
};
