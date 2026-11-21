/**
 * An academic year or term row with its `date` columns as the contract's YYYY-MM-DD. The driver
 * reads a date as a Date at UTC midnight, and returned as-is it serialized as
 * "2026-07-01T00:00:00.000Z": the web then sent that timestamp back as an attendance range bound,
 * which the API rejected (400), so a student's attendance history never loaded.
 */
export function withPeriodDates<T extends { starts_on: Date | string; ends_on: Date | string }>(
  row: T,
): Omit<T, "starts_on" | "ends_on"> & { starts_on: string; ends_on: string } {
  const day = (d: Date | string) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
  return { ...row, starts_on: day(row.starts_on), ends_on: day(row.ends_on) };
}
