import type { RecordFieldType } from "./fields";
import type { RecordValue } from "./values";

export const FULL_MASK = "••••";

/** Types whose last four characters are a useful hint and say nothing on their own. */
const HINTABLE = new Set<RecordFieldType>(["short_text", "phone", "number", "email"]);
const HINT_MIN_LENGTH = 8;

/**
 * The mask a sensitive value is shown as everywhere but the audited reveal (ADR-019). "•••• 1234"
 * for an ID-like value of at least 8 characters; "••••" for anything shorter and for every other
 * type, where even four characters of a medical note or a date of diagnosis would say too much.
 */
export function maskRecordValue(fieldType: RecordFieldType, value: RecordValue): string {
  if (!HINTABLE.has(fieldType)) return FULL_MASK;
  const text = String(value);
  return text.length >= HINT_MIN_LENGTH ? `${FULL_MASK} ${text.slice(-4)}` : FULL_MASK;
}
