/**
 * A `date` column as the API contract's YYYY-MM-DD. The driver reads a date as UTC midnight, so the
 * ISO string's first ten characters are that day. The full timestamp used to leak to the student
 * profile ("2010-07-12T00:00:00.000Z") and left the edit form's date inputs blank.
 */
export function toDateStr(d: Date | null): string | null {
  return d !== null ? d.toISOString().slice(0, 10) : null;
}
