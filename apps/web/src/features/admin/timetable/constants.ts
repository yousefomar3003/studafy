/** Day-of-week columns the grid always shows, `weekday` matching the API's 1=Mon..7=Sun convention
 * (see `TimetableSlot.weekday` in the OpenAPI contract). All seven are shown unconditionally —
 * there's no per-school "school days" setting on the backend to read instead (the onboarding
 * wizard's own weekday picker is local-only and never persisted; see `TimetableStep.tsx`). */
export const WEEKDAYS = [
  { value: 1, label: "Monday", short: "Mon" },
  { value: 2, label: "Tuesday", short: "Tue" },
  { value: 3, label: "Wednesday", short: "Wed" },
  { value: 4, label: "Thursday", short: "Thu" },
  { value: 5, label: "Friday", short: "Fri" },
  { value: 6, label: "Saturday", short: "Sat" },
  { value: 7, label: "Sunday", short: "Sun" },
] as const;

export function weekdayLabel(weekday: number): string {
  return WEEKDAYS.find((day) => day.value === weekday)?.label ?? `Day ${weekday}`;
}

/** Grid starts with this many period rows when a draft has no slots yet; growable via "Add period". */
export const DEFAULT_PERIOD_COUNT = 8;

export const STATUS_LABELS = {
  draft: "Draft",
  pending: "Submitted",
  approved: "Approved",
} as const;
