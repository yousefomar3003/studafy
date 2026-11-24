/**
 * A school calendar day (YYYY-MM-DD) as a short date. Read at noon UTC and formatted in UTC, so the
 * day shown is the day stored whatever the browser's timezone.
 */
export function formatDay(
  day: string,
  formatDate: (value: Date, options?: Intl.DateTimeFormatOptions) => string,
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" },
): string {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return formatDate(date, { ...options, timeZone: "UTC" });
}
