import { isArabic } from "../records/fields";

import type { CellValue, CustomListColumn } from "./queries";
import type { RecordFieldDefinition } from "../records/queries";

/** A column in the shape the records' field input takes, so a cell edits like a record answer. */
export function columnAsField(column: CustomListColumn): RecordFieldDefinition {
  return {
    id: column.id,
    field_type: column.field_type,
    label_en: column.label_en,
    label_ar: column.label_ar,
    help_en: null,
    help_ar: null,
    required: column.required,
    options: column.options,
    sort_order: column.sort_order,
    visibility: "staff_only",
    sensitivity: column.sensitivity,
    has_expiry: false,
  };
}

export function columnLabel(column: CustomListColumn, language: string): string {
  return isArabic(language) ? column.label_ar : column.label_en;
}

export function listName(list: { name_en: string; name_ar: string }, language: string): string {
  return isArabic(language) ? list.name_ar : list.name_en;
}

/**
 * A cell as text. A date column's value is a calendar day: only its first ten characters mean
 * anything (an API date can arrive as a midnight-UTC timestamp), so only those are shown.
 */
export function cellText(
  column: CustomListColumn,
  value: CellValue | null | undefined,
  language: string,
  words: { yes: string; no: string },
): string {
  if (value === null || value === undefined) return "";
  const optionLabel = (choice: string) => {
    const option = column.options.find((candidate) => candidate.value === choice);
    if (!option) return choice;
    return isArabic(language) ? option.label_ar : option.label_en;
  };
  if (typeof value === "boolean") return value ? words.yes : words.no;
  if (Array.isArray(value)) return value.map(optionLabel).join(", ");
  if (column.field_type === "single_choice") return optionLabel(String(value));
  if (column.field_type === "date") return String(value).slice(0, 10);
  return String(value);
}
