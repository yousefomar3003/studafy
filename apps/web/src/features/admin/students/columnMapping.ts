import {
  normalizeHeader,
  PARENT_RELATIONSHIPS,
  REQUIRED_STUDENT_IMPORT_FIELDS,
  STUDENT_IMPORT_FIELD_DEFINITIONS,
  STUDENT_IMPORT_FIELDS,
  STUDENT_STATUSES,
} from "@studafy/student-import";

import type { ColumnMapping, StudentImportField } from "@studafy/student-import";
import type { TFunction } from "i18next";

/**
 * Client-side logic for the import's column-mapping step (ST-300). The field list, aliases and
 * header normalisation come from `@studafy/student-import`, the same package the API maps with, so
 * what this page calls an exact or alias match is exactly what the server's suggestion accepts.
 */

export type { ColumnMapping, StudentImportField };

/**
 * Field display names and hints are translation keys, resolved with the caller's `t` at render time
 * so they follow a runtime language switch. The helpers below that build sentences take `t` too.
 */
export const FIELD_LABEL_KEYS: Readonly<Record<StudentImportField, string>> = {
  admission_number: "adminPeople.students.import.fields.admission_number",
  email: "adminPeople.students.import.fields.email",
  first_name: "adminPeople.students.import.fields.first_name",
  middle_name: "adminPeople.students.import.fields.middle_name",
  last_name: "adminPeople.students.import.fields.last_name",
  preferred_name: "adminPeople.students.import.fields.preferred_name",
  date_of_birth: "adminPeople.students.import.fields.date_of_birth",
  status: "adminPeople.students.import.fields.status",
  parent_email: "adminPeople.students.import.fields.parent_email",
  parent_name: "adminPeople.students.import.fields.parent_name",
  parent_relationship: "adminPeople.students.import.fields.parent_relationship",
};

const FIELD_HINT_KEYS: Readonly<Partial<Record<StudentImportField, string>>> = {
  admission_number: "adminPeople.students.import.hints.admission_number",
  email: "adminPeople.students.import.hints.email",
  date_of_birth: "adminPeople.students.import.hints.date_of_birth",
  status: "adminPeople.students.import.hints.status",
  parent_email: "adminPeople.students.import.hints.parent_email",
  parent_name: "adminPeople.students.import.hints.parent_name",
  parent_relationship: "adminPeople.students.import.hints.parent_relationship",
};

export function fieldLabel(field: StudentImportField, t: TFunction): string {
  // eslint-disable-next-line security/detect-object-injection -- `field` is a `StudentImportField`, keyed into this module's own fixed map
  return t(FIELD_LABEL_KEYS[field]);
}

/** The accepted values in the status/relationship hints are the CSV's literal codes, so they stay
 * untranslated inside the localized sentence. */
export function fieldHint(field: StudentImportField, t: TFunction): string | undefined {
  // eslint-disable-next-line security/detect-object-injection -- `field` is a `StudentImportField`, keyed into this module's own fixed map
  const key = FIELD_HINT_KEYS[field];
  if (!key) return undefined;
  if (field === "status") return t(key, { values: STUDENT_STATUSES.join(", ") });
  if (field === "parent_relationship") return t(key, { values: PARENT_RELATIONSHIPS.join(", ") });
  return t(key);
}

export { REQUIRED_STUDENT_IMPORT_FIELDS, STUDENT_IMPORT_FIELDS };

/**
 * How closely a source header's name matches the field it is mapped to. This is a statement about
 * the header text, not about the data in the column:
 * - `exact`: the header is the field's own name (`First Name` for `first_name`).
 * - `alias`: the header is a known alternative (`Surname` for `last_name`).
 * - `partial`: the header contains the field's name or an alias (`Student Last Name`). Only this
 *   page suggests these; the server never does, so they always need a look.
 * - `manual`: no name relation; someone chose it.
 */
export type MatchConfidence = "exact" | "alias" | "partial" | "manual";

/** Names shorter than this are too generic to look for inside a longer header ("dob", "last"). */
const MIN_PARTIAL_KEY_LENGTH = 5;

function fieldKeys(field: StudentImportField): { name: string; aliases: string[] } {
  return {
    name: normalizeHeader(field),
    aliases: STUDENT_IMPORT_FIELD_DEFINITIONS[field].aliases.map(normalizeHeader),
  };
}

export function matchConfidence(field: StudentImportField, header: string): MatchConfidence {
  const key = normalizeHeader(header);
  const { name, aliases } = fieldKeys(field);
  if (key === name) return "exact";
  if (aliases.includes(key)) return "alias";
  const partial = [name, ...aliases].some(
    (candidate) => candidate.length >= MIN_PARTIAL_KEY_LENGTH && key.includes(candidate),
  );
  return partial ? "partial" : "manual";
}

/**
 * The server's mapping plus a `partial` suggestion for each field it left unmapped, taken from the
 * first header no field has claimed yet. Only for a fresh upload: after a re-map, the applied
 * mapping is what the admin chose and is shown unchanged.
 */
export function withPartialSuggestions(
  mapping: ColumnMapping,
  headers: readonly string[],
): ColumnMapping {
  const suggested: ColumnMapping = { ...mapping };
  const claimed = new Set(Object.values(suggested));
  for (const field of STUDENT_IMPORT_FIELDS) {
    if (suggested[field] !== undefined) continue;
    const header = headers.find(
      (candidate) => !claimed.has(candidate) && matchConfidence(field, candidate) === "partial",
    );
    if (header === undefined) continue;
    suggested[field] = header;
    claimed.add(header);
  }
  return suggested;
}

/** Map `field` to `header` (or unmap it with `undefined`). A column feeds one field only, so a
 * header already mapped elsewhere moves to `field`. */
export function assignColumn(
  mapping: ColumnMapping,
  field: StudentImportField,
  header: string | undefined,
): ColumnMapping {
  const next: ColumnMapping = {};
  for (const other of STUDENT_IMPORT_FIELDS) {
    const current = mapping[other];
    if (other !== field && current !== undefined && current !== header) next[other] = current;
  }
  if (header !== undefined) next[field] = header;
  return next;
}

export function missingRequiredFields(mapping: ColumnMapping): StudentImportField[] {
  return REQUIRED_STUDENT_IMPORT_FIELDS.filter((field) => mapping[field] === undefined);
}

export function isSameMapping(a: ColumnMapping, b: ColumnMapping): boolean {
  return STUDENT_IMPORT_FIELDS.every((field) => a[field] === b[field]);
}

/** Whether every column a saved mapping reads exists in this file. Headers compare the way the
 * server compares them, so `Student ID` in the mapping matches `student id` in the file. */
export function mappingFitsHeaders(mapping: ColumnMapping, headers: readonly string[]): boolean {
  const keys = new Set(headers.map(normalizeHeader));
  return Object.values(mapping).every((header) => keys.has(normalizeHeader(header)));
}

/** A parent is all or nothing on the server: a row naming only one of these two is rejected. */
export function parentPairWarning(mapping: ColumnMapping, t: TFunction): string | null {
  const hasEmail = mapping.parent_email !== undefined;
  const hasRelationship = mapping.parent_relationship !== undefined;
  if (hasEmail === hasRelationship) return null;
  return t("adminPeople.students.import.parentPairWarning", {
    email: fieldLabel("parent_email", t),
    relationship: fieldLabel("parent_relationship", t),
  });
}

export function joinLabels(fields: readonly StudentImportField[], t: TFunction): string {
  return fields.map((field) => fieldLabel(field, t)).join(t("adminPeople.common.listSeparator"));
}

/**
 * Why confirm is blocked, checked in the order an admin would fix things; `null` means it isn't.
 * `draft` is what the panel shows; `applied` is what the server staged and validated.
 */
export function confirmBlocker(
  draft: ColumnMapping,
  applied: ColumnMapping,
  validRows: number,
  t: TFunction,
): string | null {
  const missing = missingRequiredFields(draft);
  if (missing.length > 0) {
    return t("adminPeople.students.import.blocker.missing", { fields: joinLabels(missing, t) });
  }
  if (!isSameMapping(draft, applied)) {
    return t("adminPeople.students.import.blocker.unapplied");
  }
  if (validRows === 0) return t("adminPeople.students.import.blocker.noValidRows");
  return null;
}
