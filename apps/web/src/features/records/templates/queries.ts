import { useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type RecordSubjectKind = components["schemas"]["RecordSubjectKind"];
export type RecordFieldType = components["schemas"]["RecordFieldType"];
export type RecordFieldVisibility = components["schemas"]["RecordFieldVisibility"];
export type RecordFieldSensitivity = components["schemas"]["RecordFieldSensitivity"];
export type RecordFieldOption = components["schemas"]["RecordFieldOption"];
// Restated with plain arrays, as `../../finance/unlinked/queries.ts` does, because the generated
// `readonly` arrays lose their array prototype through `api.GET`'s response typing.
export type RecordTemplateField = Omit<components["schemas"]["RecordTemplateField"], "options"> & {
  options: RecordFieldOption[];
};
export type RecordTemplate = Omit<components["schemas"]["RecordTemplate"], "fields"> & {
  fields: RecordTemplateField[];
};

export const RECORD_FIELD_TYPES: readonly RecordFieldType[] = [
  "short_text",
  "long_text",
  "number",
  "date",
  "single_choice",
  "multi_choice",
  "yes_no",
  "phone",
  "email",
  "document",
];

export const RECORD_FIELD_VISIBILITIES: readonly RecordFieldVisibility[] = [
  "staff_only",
  "finance",
  "teachers",
  "parent",
];

/** Months a sensitive answer is kept after the person leaves when the school sets none. */
export const DEFAULT_RETENTION_MONTHS = 12;

export function isChoiceType(type: RecordFieldType): boolean {
  return type === "single_choice" || type === "multi_choice";
}

export function recordTemplateKey(kind: RecordSubjectKind) {
  return ["records", "template", kind] as const;
}

export async function fetchRecordTemplate(kind: RecordSubjectKind): Promise<RecordTemplate> {
  const { data } = await api.GET("/api/record-templates/{subjectKind}", {
    params: { path: { subjectKind: kind } },
  });
  if (!data) throw new Error("Record template fetch returned no data.");
  return data as RecordTemplate;
}

export function useRecordTemplateQuery(kind: RecordSubjectKind) {
  return useQuery({ queryKey: recordTemplateKey(kind), queryFn: () => fetchRecordTemplate(kind) });
}
