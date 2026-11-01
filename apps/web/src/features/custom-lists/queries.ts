import { ROLES } from "@studafy/constants";

import { api } from "../../lib/api";

import type { components } from "@studafy/api-client";

export type CustomListSummary = components["schemas"]["CustomListSummary"];
export type CustomListDetail = components["schemas"]["CustomListDetail"];
export type CustomListColumn = components["schemas"]["CustomListColumn"];
export type CustomListRow = components["schemas"]["CustomListRow"];
export type CustomListRowPage = components["schemas"]["CustomListRowPage"];
export type CustomListCell = components["schemas"]["CustomListCell"];
export type CustomListAudience = components["schemas"]["CustomListAudience"];
export type CustomListLinkKind = components["schemas"]["CustomListLinkKind"];
export type CustomListLinks = components["schemas"]["CustomListLinks"];
export type CustomListLinked = components["schemas"]["CustomListLinkedRows"];
export type CustomListImportBody = components["schemas"]["CustomListImportBody"];
export type CustomListImportPreview = components["schemas"]["CustomListImportPreview"];
export type CustomListImportKey = components["schemas"]["CustomListImportKey"];
export type ColumnFieldType = components["schemas"]["RecordColumnFieldType"];
export type CellValue = components["schemas"]["RecordValue"];

export const LINK_KINDS: readonly CustomListLinkKind[] = ["student", "parent", "staff", "class"];
export const AUDIENCES: readonly CustomListAudience[] = ["admins", "leadership", "staff"];
export const COLUMN_TYPES: readonly ColumnFieldType[] = [
  "short_text",
  "long_text",
  "number",
  "date",
  "single_choice",
  "multi_choice",
  "yes_no",
  "phone",
  "email",
];
export const IMPORT_KEYS: readonly CustomListImportKey[] = [
  "member_id",
  "admission_number",
  "employee_number",
  "class_code",
];

/** The only page of the Lists area; one top-level path for every staff role that may use lists. */
export const LISTS_PATH = "/portal/lists";

export function listHref(listId: string): string {
  return `${LISTS_PATH}/${listId}`;
}

/**
 * The audiences a caller may give a list: one they belong to, or the list would be hidden from
 * them (the API refuses the rest). Mirrors app.can_read_custom_list (000182).
 */
export function audiencesFor(roles: readonly string[]): CustomListAudience[] {
  const admin = roles.includes(ROLES.ORG_ADMIN) || roles.includes(ROLES.SUPER_ADMIN);
  if (admin) return ["admins", "leadership", "staff"];
  if (roles.includes(ROLES.PRINCIPAL)) return ["leadership", "staff"];
  return ["staff"];
}

export const customListsKey = ["custom-lists"] as const;

export function customListsQueryKey(includeArchived: boolean) {
  return [...customListsKey, "index", includeArchived] as const;
}

export function customListQueryKey(listId: string) {
  return [...customListsKey, "list", listId] as const;
}

export function customListRowsQueryKey(listId: string, query: RowsQuery) {
  return [...customListsKey, "rows", listId, query] as const;
}

export function linkedRowsQueryKey(kind: CustomListLinkKind, subjectId: string) {
  return [...customListsKey, "linked", kind, subjectId] as const;
}

// The generated `readonly` arrays lose their array prototype through `api.GET`'s response typing
// (as records/queries.ts notes), so results are restated as their plain schema types.

export async function fetchCustomLists(includeArchived: boolean) {
  const { data } = await api.GET("/api/custom-lists", {
    params: { query: includeArchived ? { include_archived: "true" } : {} },
  });
  return data as components["schemas"]["CustomListList"];
}

export async function fetchCustomList(listId: string): Promise<CustomListDetail> {
  const { data } = await api.GET("/api/custom-lists/{listId}", {
    params: { path: { listId } },
  });
  return data as CustomListDetail;
}

export interface RowsQuery {
  q?: string;
  sort?: string;
  order?: "asc" | "desc";
  filter_column?: string;
  filter_value?: string;
  limit: number;
  offset: number;
}

export async function fetchCustomListRows(
  listId: string,
  query: RowsQuery,
): Promise<CustomListRowPage> {
  const { data } = await api.GET("/api/custom-lists/{listId}/rows", {
    params: { path: { listId }, query },
  });
  return data as CustomListRowPage;
}

export async function fetchLinkedRows(
  kind: CustomListLinkKind,
  subjectId: string,
): Promise<CustomListLinked> {
  const { data } = await api.GET("/api/custom-lists/linked/{subjectKind}/{subjectId}", {
    params: { path: { subjectKind: kind, subjectId } },
  });
  return { lists: (data as CustomListLinked | undefined)?.lists ?? [] };
}

export async function revealCell(
  listId: string,
  rowId: string,
  columnId: string,
): Promise<CellValue | null> {
  const { data } = await api.POST(
    "/api/custom-lists/{listId}/rows/{rowId}/cells/{columnId}/reveal",
    { params: { path: { listId, rowId, columnId } } },
  );
  return (data?.value ?? null) as CellValue | null;
}

/** The CSV export, fetched with the session's token (a plain link could not carry it). */
export async function fetchExport(listId: string, lang: "en" | "ar"): Promise<Blob> {
  const { data } = await api.GET("/api/custom-lists/{listId}/export", {
    params: { path: { listId }, query: { lang } },
    parseAs: "blob",
  });
  if (!data) throw new Error("Export unavailable");
  return data as unknown as Blob;
}
