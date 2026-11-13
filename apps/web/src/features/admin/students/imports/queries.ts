import { api } from "../../../../lib/api";

import type { components } from "@studafy/api-client";

export type ImportListItem = components["schemas"]["ImportListItem"];
export type ImportRecord = components["schemas"]["ImportRecord"];
export type UnmappedColumns = components["schemas"]["UnmappedColumns"];
export type UnmappedColumn = components["schemas"]["UnmappedColumn"];
export type ImportColumnTarget = components["schemas"]["ImportColumnTarget"];
export type ParentSlot = components["schemas"]["ImportParentSlot"];
export type ImportColumnPreview = components["schemas"]["ImportColumnPreview"];
export type ImportColumnPreviewRow = components["schemas"]["ImportColumnPreviewRow"];
export type ImportColumnApplyResult = components["schemas"]["ImportColumnApplyResult"];
export type ImportSettings = components["schemas"]["ImportSettings"];
export type RecordFieldDefinition = components["schemas"]["RecordFieldDefinition"];
export type RecordSubjectKind = "student" | "parent";

export const IMPORT_HISTORY_KEY = ["students", "import-history"] as const;
export const IMPORT_SETTINGS_KEY = ["students", "import-settings"] as const;

export function importHistoryPageKey(cursor: string | undefined) {
  return [...IMPORT_HISTORY_KEY, cursor ?? "first"] as const;
}

export function importDetailKey(importId: string) {
  return [...IMPORT_HISTORY_KEY, "detail", importId] as const;
}

export function importColumnsKey(importId: string) {
  return [...importDetailKey(importId), "columns"] as const;
}

export function recordFormKey(kind: RecordSubjectKind) {
  return ["students", "import-history", "record-form", kind] as const;
}

/** `GET /api/imports/students` — newest first, keyset-paginated. */
export async function fetchImportHistoryPage(
  cursor: string | undefined,
): Promise<{ imports: ImportListItem[]; next_cursor: string | null }> {
  const { data } = await api.GET("/api/imports/students", {
    params: { query: { limit: 20, ...(cursor ? { cursor } : {}) } },
  });
  return {
    imports: (data?.imports ?? []) as ImportListItem[],
    next_cursor: data?.next_cursor ?? null,
  };
}

export async function fetchImport(importId: string): Promise<ImportRecord> {
  const { data } = await api.GET("/api/imports/students/{importId}", {
    params: { path: { importId } },
  });
  if (!data) throw new Error("Import not found.");
  return data as ImportRecord;
}

/** `GET /api/imports/students/{importId}/columns` — the columns no field read, with suggestions. */
export async function fetchImportColumns(importId: string): Promise<UnmappedColumns> {
  const { data } = await api.GET("/api/imports/students/{importId}/columns", {
    params: { path: { importId } },
  });
  if (!data) throw new Error("Import columns returned no data.");
  return data as UnmappedColumns;
}

export async function fetchImportSettings(): Promise<ImportSettings> {
  const { data } = await api.GET("/api/imports/students/settings");
  if (!data) throw new Error("Import settings returned no data.");
  return data as ImportSettings;
}

/**
 * `GET /api/record-forms/{subjectKind}` — the published form a column can be written to. Document
 * fields are left out: they take uploaded files, not a column of values.
 */
export async function fetchRecordForm(kind: RecordSubjectKind): Promise<RecordFieldDefinition[]> {
  const { data } = await api.GET("/api/record-forms/{subjectKind}", {
    params: { path: { subjectKind: kind } },
  });
  return ((data?.fields ?? []) as RecordFieldDefinition[]).filter(
    (field) => field.field_type !== "document",
  );
}
