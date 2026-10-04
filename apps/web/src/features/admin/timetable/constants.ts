import type { TFunction } from "i18next";

/** Day-of-week columns the grid always shows, `weekday` matching the API's 1=Mon..7=Sun convention
 * (see `TimetableSlot.weekday` in the OpenAPI contract). All seven are shown unconditionally —
 * there's no per-school "school days" setting on the backend to read instead (the onboarding
 * wizard's own weekday picker is local-only and never persisted; see `TimetableStep.tsx`).
 * Labels are translation keys (`adminSchool.timetable.weekdays*`), resolved with `t()` at render time. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7].map((value) => ({
  value,
  labelKey: `adminSchool.timetable.weekdays.${value}`,
  shortKey: `adminSchool.timetable.weekdaysShort.${value}`,
}));

export function weekdayLabel(weekday: number, t: TFunction): string {
  const day = WEEKDAYS.find((candidate) => candidate.value === weekday);
  return day ? t(day.labelKey) : t("adminSchool.timetable.dayFallback", { weekday });
}

/** Grid starts with this many period rows when a draft has no slots yet; growable via "Add period". */
export const DEFAULT_PERIOD_COUNT = 8;

/** Version status display names, as translation keys resolved with `t()` at render time. */
export const STATUS_LABEL_KEYS = {
  draft: "adminSchool.timetable.status.draft",
  pending: "adminSchool.timetable.status.pending",
  approved: "adminSchool.timetable.status.approved",
} as const;

/** Full "this version is … and read-only" sentences per status, as translation keys. */
export const READ_ONLY_NOTE_KEYS = {
  draft: "adminSchool.timetable.readOnlyNote.draft",
  pending: "adminSchool.timetable.readOnlyNote.pending",
  approved: "adminSchool.timetable.readOnlyNote.approved",
} as const;
