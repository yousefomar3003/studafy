import type { TFunction } from "i18next";

/** The seven weekdays, `weekday` matching the API's 1=Mon..7=Sun convention (see `TimetableSlot.weekday`
 * in the OpenAPI contract). Which of them the grid shows comes from the school week setting
 * (`GET /api/academics/timetable-settings`). Labels are translation keys
 * (`adminSchool.timetable.weekdays*`), resolved with `t()` at render time. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7].map((value) => ({
  value,
  labelKey: `adminSchool.timetable.weekdays.${value}`,
  shortKey: `adminSchool.timetable.weekdaysShort.${value}`,
}));

export function weekdayLabel(weekday: number, t: TFunction): string {
  const day = WEEKDAYS.find((candidate) => candidate.value === weekday);
  return day ? t(day.labelKey) : t("adminSchool.timetable.dayFallback", { weekday });
}
