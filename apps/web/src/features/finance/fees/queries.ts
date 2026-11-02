import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type FeeStructure = components["schemas"]["FeeStructure"];
export type AcademicYear = components["schemas"]["AcademicYear"];
export type CreateFeeStructureBody = components["schemas"]["CreateFeeStructureBody"];
export type UpdateFeeStructureBody = components["schemas"]["UpdateFeeStructureBody"];

// ---------------------------------------------------------------------------
// Pagination fan-out
//
// Kept local rather than shared, matching `admin/timetable/queries.ts`'s own copy of the same
// helper — each feature owns its own data-fetching file.
// ---------------------------------------------------------------------------

const MAX_PAGES = 20;

async function fetchAllOffsetPages<TRow>(
  fetchPage: (limit: number, offset: number) => Promise<{ rows: TRow[]; total: number }>,
  pageSize = 100,
): Promise<TRow[]> {
  const rows: TRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(pageSize, page * pageSize);
    rows.push(...result.rows);
    if (result.rows.length < pageSize || rows.length >= result.total) {
      break;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export function feeStructuresQueryKey(academicYearId: string) {
  return ["finance", "fee-structures", academicYearId] as const;
}
export const ACADEMIC_YEARS_KEY = ["finance", "fee-structures", "academic-years"] as const;
// ---------------------------------------------------------------------------
// Fee structures
// ---------------------------------------------------------------------------

/** `""` means "every academic year" — `academic_year_id` is left off the request entirely rather
 * than sent empty, matching `feeStructureQuerySchema`'s optional-uuid contract. */
export async function fetchFeeStructures(academicYearId: string): Promise<FeeStructure[]> {
  return fetchAllOffsetPages(async (limit, offset) => {
    const { data } = await api.GET("/api/finance/fee-structures", {
      params: {
        query: { academic_year_id: academicYearId || undefined, limit, offset },
      },
    });
    // `readonly FeeStructure[]` loses its array prototype through the generated response type —
    // the same `@studafy/api-client` typing gap `finance/queries.ts` documents for `Payment[]`.
    return {
      rows: (data?.fee_structures ?? []) as FeeStructure[],
      total: data?.total ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Academic years — for the effective-dating picker (a fee structure's own record carries no
// effective-from/to fields; the academic year it belongs to is the only dating Studafy has).
// ---------------------------------------------------------------------------

export async function fetchAcademicYears(): Promise<AcademicYear[]> {
  return fetchAllOffsetPages(async (limit, offset) => {
    const { data } = await api.GET("/api/academics/years", {
      params: { query: { limit, offset } },
    });
    return { rows: (data?.academic_years ?? []) as AcademicYear[], total: data?.total ?? 0 };
  });
}
