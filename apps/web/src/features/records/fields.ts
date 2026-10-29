import type { RecordFieldDefinition, RecordValue } from "./queries";

/** What an input holds while being edited: text, a list of choices, yes/no, or nothing. */
export type RecordDraft = string | string[] | boolean | null;

export function isArabic(language: string): boolean {
  return language.toLowerCase().startsWith("ar");
}

/** A field's label in the active language. */
export function fieldLabel(field: RecordFieldDefinition, language: string): string {
  return isArabic(language) ? field.label_ar : field.label_en;
}

export function fieldHelp(field: RecordFieldDefinition, language: string): string | null {
  return isArabic(language) ? field.help_ar : field.help_en;
}

function optionLabel(
  fields: readonly (RecordFieldDefinition | null | undefined)[],
  value: string,
  language: string,
): string {
  for (const field of fields) {
    const option = field?.options.find((candidate) => candidate.value === value);
    if (option) return isArabic(language) ? option.label_ar : option.label_en;
  }
  return value;
}

/**
 * A stored answer as text. Choice values are labelled from the current field first and then from
 * the field as it read when answered, so an option since removed still reads as it was chosen.
 */
export function displayValue(
  value: RecordValue,
  fields: readonly (RecordFieldDefinition | null | undefined)[],
  language: string,
  words: { yes: string; no: string },
  formatDay: (iso: string) => string,
): string {
  if (value === null) return "";
  const type = fields[0]?.field_type;
  if (typeof value === "boolean") return value ? words.yes : words.no;
  if (Array.isArray(value))
    return value.map((item) => optionLabel(fields, item, language)).join(", ");
  if (type === "single_choice" && typeof value === "string") {
    return optionLabel(fields, value, language);
  }
  if (type === "date" && typeof value === "string") return formatDay(value);
  return String(value);
}

export function draftFor(field: RecordFieldDefinition, value: RecordValue): RecordDraft {
  if (value === null) return field.field_type === "multi_choice" ? [] : null;
  if (field.field_type === "multi_choice") return Array.isArray(value) ? [...value] : [];
  if (field.field_type === "yes_no") return typeof value === "boolean" ? value : null;
  return String(value);
}

/** The draft as the API takes it, or null for "no answer". */
export function valueFromDraft(field: RecordFieldDefinition, draft: RecordDraft): RecordValue {
  if (draft === null) return null;
  if (typeof draft === "boolean") return draft;
  if (Array.isArray(draft)) return draft.length > 0 ? draft : null;
  const text = draft.trim();
  if (text === "") return null;
  if (field.field_type === "number") {
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }
  return text;
}

export function sameValue(left: RecordValue, right: RecordValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A YYYY-MM-DD day as local midnight, so it never shifts across timezones when formatted. */
export function calendarDay(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}
