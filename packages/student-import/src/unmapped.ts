import { labelSuggestsSensitive, normalizeRecordValue } from "@studafy/records/browser";

import { STUDENT_IMPORT_FIELDS } from "./fields";
import { normalizeHeader } from "./mapping";

import type { ColumnMapping } from "./mapping";
import type { RecordFieldOption, RecordFieldType } from "@studafy/records/browser";

/** One source column no import field or template field reads. */
export interface UnmappedColumn {
  /** 0-based index in the import's source headers. */
  position: number;
  header: string;
  normalized_header: string;
}

/**
 * The source columns `mapping` leaves unread, in file order. Headers match the mapping
 * case-, spacing- and punctuation-insensitively, as staging does.
 */
export function unmappedColumns(
  headers: readonly string[],
  mapping: ColumnMapping,
): UnmappedColumn[] {
  const claimed = new Set<string>();
  for (const field of STUDENT_IMPORT_FIELDS) {
    const header = mapping[field];
    if (header !== undefined) claimed.add(normalizeHeader(header));
  }
  for (const header of Object.values(mapping.records ?? {})) claimed.add(normalizeHeader(header));

  return headers.flatMap((header, position) => {
    const normalized = normalizeHeader(header);
    return claimed.has(normalized) ? [] : [{ position, header, normalized_header: normalized }];
  });
}

/** The record field types a column can be created as (never a document). */
export type ImportableFieldType = Exclude<RecordFieldType, "document">;

export interface ColumnGuess {
  field_type: ImportableFieldType;
  /** Choices for a single_choice guess; empty otherwise. */
  options: RecordFieldOption[];
  /** Why the column looks sensitive, or null. A hint: the school decides. */
  sensitive_reason: "label" | "values" | null;
}

/** Above this many distinct values a column is text, not a choice. */
const MAX_CHOICES = 12;
const MAX_CHOICE_LENGTH = 60;

/** Salary and pay, which `labelSuggestsSensitive` (identity and health) does not cover. */
const PAY_HINTS: readonly RegExp[] = [
  /\b(salary|salaries|income|wage|wages|payroll|pay\s*(grade|scale|slip)|earnings|bank\s*(account|iban)|iban)\b/i,
  /(راتب|الراتب|رواتب|دخل|الدخل|أجر|الأجر|حساب\s*بنكي|آيبان)/,
];

const PHONE_HINTS: readonly RegExp[] = [
  /\b(phone|mobile|cell|tel|telephone|whatsapp|contact\s*number)\b/i,
  /(هاتف|الهاتف|جوال|الجوال|موبايل|واتساب|رقم\s*التواصل)/,
];

/** Digits only, long enough to be an identifier rather than a quantity. */
const ID_LIKE = /^\d{8,}$/;
const ID_WITH_SEPARATORS = /^\d{3,}[-\s]\d{2,}[-\s]?\d*[-\s]?\d*$/;
const PASSPORT_LIKE = /^[A-Za-z]{1,2}\d{6,9}$/;

function headerSuggestsSensitive(header: string): boolean {
  return labelSuggestsSensitive(header) || PAY_HINTS.some((pattern) => pattern.test(header));
}

function matchesType(fieldType: ImportableFieldType, values: readonly string[]): boolean {
  return values.every(
    (value) => normalizeRecordValue({ field_type: fieldType, options: [] }, value).ok,
  );
}

/** A stable option value for a choice label: lower-case ASCII, or its position when the label has
 * none (an Arabic label). Unique within the set. */
function optionValues(labels: readonly string[]): string[] {
  const used = new Set<string>();
  return labels.map((label, index) => {
    const base =
      label
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || `option_${index + 1}`;
    let value = base;
    for (let n = 2; used.has(value); n++) value = `${base}_${n}`;
    used.add(value);
    return value;
  });
}

/**
 * Guess a record field type for a column from its header and its non-empty values, and whether it
 * looks sensitive (an ID number, passport, medical or pay data). Computed here, from the cells
 * themselves: imported values are never sent anywhere else to be classified.
 *
 * Dates are guessed only when every value is already YYYY-MM-DD; "03/04/2010" is ambiguous between
 * day-first and month-first, so such a column stays text rather than being silently reordered. A
 * long run of digits is an identifier, never a number: a civil ID or passport number loses its
 * leading zeros and its meaning as a number.
 */
export function guessColumn(header: string, rawValues: readonly string[]): ColumnGuess {
  const values = rawValues.map((value) => value.trim()).filter((value) => value !== "");
  const headerSensitive = headerSuggestsSensitive(header);
  const idLike =
    values.length > 0 &&
    values.every(
      (value) => ID_LIKE.test(value) || ID_WITH_SEPARATORS.test(value) || PASSPORT_LIKE.test(value),
    );
  const phoneHeader = PHONE_HINTS.some((pattern) => pattern.test(header));
  const sensitive_reason: ColumnGuess["sensitive_reason"] = headerSensitive
    ? "label"
    : idLike && !phoneHeader
      ? "values"
      : null;

  const guess = (
    field_type: ImportableFieldType,
    options: RecordFieldOption[] = [],
  ): ColumnGuess => ({
    field_type,
    options,
    sensitive_reason,
  });

  if (values.length === 0) return guess("short_text");
  if (matchesType("yes_no", values)) {
    // "1"/"0" alone reads as yes/no to the validator, but a column of only 1s is more likely a count.
    const words = values.some((value) => !/^[01]$/.test(value));
    if (words || new Set(values).size === 2) return guess("yes_no");
  }
  if (matchesType("date", values)) return guess("date");
  if (phoneHeader && matchesType("phone", values)) return guess("phone");
  if (matchesType("email", values)) return guess("email");
  if (!idLike && matchesType("number", values) && values.every((value) => !/^0\d/.test(value))) {
    return guess("number");
  }
  if (idLike) return guess("short_text");
  if (
    values.some((value) => /[+()\s-]/.test(value)) &&
    matchesType("phone", values) &&
    values.every((value) => value.replace(/\D/g, "").length >= 7)
  ) {
    return guess("phone");
  }

  // Choices match case-insensitively (normalizeRecordValue), so "Red" and "red" are one choice.
  const byKey = new Map<string, string>();
  for (const value of values) {
    if (!byKey.has(value.toLowerCase())) byKey.set(value.toLowerCase(), value);
  }
  const distinct = [...byKey.values()];
  if (
    distinct.length >= 2 &&
    distinct.length <= MAX_CHOICES &&
    values.length >= distinct.length * 2 &&
    distinct.every((value) => value.length <= MAX_CHOICE_LENGTH && !/[;|]/.test(value))
  ) {
    const labels = distinct.sort((a, b) => a.localeCompare(b));
    const keys = optionValues(labels);
    return guess(
      "single_choice",
      labels.map((label, index) => ({ value: keys[index]!, label_en: label, label_ar: label })),
    );
  }

  return guess(values.some((value) => value.length > 500) ? "long_text" : "short_text");
}
