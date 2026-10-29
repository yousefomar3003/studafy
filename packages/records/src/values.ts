import type { RecordFieldOption, RecordFieldType } from "./fields";

/** One answer, as stored (plaintext jsonb) or sealed (ADR-019). Documents have no value. */
export type RecordValue = string | number | boolean | string[];

export interface RecordValueField {
  field_type: RecordFieldType;
  options: readonly RecordFieldOption[];
}

export const RECORD_VALUE_ERRORS = [
  "RECORD_VALUE_WRONG_TYPE",
  "RECORD_VALUE_TOO_LONG",
  "RECORD_VALUE_INVALID_NUMBER",
  "RECORD_VALUE_INVALID_DATE",
  "RECORD_VALUE_INVALID_CHOICE",
  "RECORD_VALUE_INVALID_PHONE",
  "RECORD_VALUE_INVALID_EMAIL",
  "RECORD_VALUE_DOCUMENT_FIELD",
] as const;
export type RecordValueError = (typeof RECORD_VALUE_ERRORS)[number];

export type NormalizedRecordValue =
  { ok: true; value: RecordValue | null } | { ok: false; error: RecordValueError };

export const SHORT_TEXT_MAX = 500;
export const LONG_TEXT_MAX = 10_000;

const YES = new Set(["yes", "y", "true", "1", "نعم"]);
const NO = new Set(["no", "n", "false", "0", "لا"]);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PHONE = /^\+?[\d\s\-().]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ok(value: RecordValue | null): NormalizedRecordValue {
  return { ok: true, value };
}

function fail(error: RecordValueError): NormalizedRecordValue {
  return { ok: false, error };
}

function text(raw: unknown, max: number): NormalizedRecordValue {
  if (typeof raw !== "string") return fail("RECORD_VALUE_WRONG_TYPE");
  const trimmed = raw.trim();
  if (trimmed === "") return ok(null);
  return trimmed.length > max ? fail("RECORD_VALUE_TOO_LONG") : ok(trimmed);
}

/**
 * Validate and normalize one answer against its field. Accepts the JSON shape the API takes and
 * the plain strings a CSV cell holds (multi-choice cells separated by ";" or "|", yes/no as
 * yes/no/true/false/نعم/لا). An empty value normalizes to null: "no answer", never an error, so a
 * missing required field never blocks a save.
 */
export function normalizeRecordValue(field: RecordValueField, raw: unknown): NormalizedRecordValue {
  if (raw === null || raw === undefined) return ok(null);

  switch (field.field_type) {
    case "document":
      return fail("RECORD_VALUE_DOCUMENT_FIELD");
    case "short_text":
      return text(raw, SHORT_TEXT_MAX);
    case "long_text":
      return text(raw, LONG_TEXT_MAX);
    case "number": {
      if (typeof raw === "string" && raw.trim() === "") return ok(null);
      const parsed =
        typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
      return Number.isFinite(parsed) ? ok(parsed) : fail("RECORD_VALUE_INVALID_NUMBER");
    }
    case "date": {
      if (typeof raw !== "string") return fail("RECORD_VALUE_WRONG_TYPE");
      const trimmed = raw.trim();
      if (trimmed === "") return ok(null);
      const match = ISO_DATE.exec(trimmed);
      if (!match) return fail("RECORD_VALUE_INVALID_DATE");
      const date = new Date(`${trimmed}T00:00:00Z`);
      const valid =
        !Number.isNaN(date.getTime()) &&
        date.getUTCFullYear() === Number(match[1]) &&
        date.getUTCMonth() + 1 === Number(match[2]) &&
        date.getUTCDate() === Number(match[3]);
      return valid ? ok(trimmed) : fail("RECORD_VALUE_INVALID_DATE");
    }
    case "single_choice": {
      if (typeof raw !== "string") return fail("RECORD_VALUE_WRONG_TYPE");
      const trimmed = raw.trim();
      if (trimmed === "") return ok(null);
      const option = matchOption(field.options, trimmed);
      return option ? ok(option) : fail("RECORD_VALUE_INVALID_CHOICE");
    }
    case "multi_choice": {
      const items =
        typeof raw === "string"
          ? raw.split(/[;|]/)
          : Array.isArray(raw) && raw.every((item) => typeof item === "string")
            ? (raw as string[])
            : null;
      if (items === null) return fail("RECORD_VALUE_WRONG_TYPE");
      const chosen: string[] = [];
      for (const item of items) {
        const trimmed = item.trim();
        if (trimmed === "") continue;
        const option = matchOption(field.options, trimmed);
        if (!option) return fail("RECORD_VALUE_INVALID_CHOICE");
        if (!chosen.includes(option)) chosen.push(option);
      }
      return ok(chosen.length > 0 ? chosen : null);
    }
    case "yes_no": {
      if (typeof raw === "boolean") return ok(raw);
      if (typeof raw !== "string") return fail("RECORD_VALUE_WRONG_TYPE");
      const lowered = raw.trim().toLowerCase();
      if (lowered === "") return ok(null);
      if (YES.has(lowered)) return ok(true);
      if (NO.has(lowered)) return ok(false);
      return fail("RECORD_VALUE_WRONG_TYPE");
    }
    case "phone": {
      if (typeof raw !== "string") return fail("RECORD_VALUE_WRONG_TYPE");
      const trimmed = raw.trim();
      if (trimmed === "") return ok(null);
      const digits = trimmed.replace(/\D/g, "").length;
      return PHONE.test(trimmed) && digits >= 6 && digits <= 20
        ? ok(trimmed)
        : fail("RECORD_VALUE_INVALID_PHONE");
    }
    case "email": {
      if (typeof raw !== "string") return fail("RECORD_VALUE_WRONG_TYPE");
      const trimmed = raw.trim();
      if (trimmed === "") return ok(null);
      return trimmed.length <= 254 && EMAIL.test(trimmed)
        ? ok(trimmed)
        : fail("RECORD_VALUE_INVALID_EMAIL");
    }
  }
}

/** A choice matches by its stored value, or (for CSV cells) by either label, case-insensitively. */
function matchOption(options: readonly RecordFieldOption[], input: string): string | null {
  const lowered = input.toLowerCase();
  const option =
    options.find((candidate) => candidate.value === input) ??
    options.find(
      (candidate) =>
        candidate.value.toLowerCase() === lowered ||
        candidate.label_en.toLowerCase() === lowered ||
        candidate.label_ar === input,
    );
  return option?.value ?? null;
}
