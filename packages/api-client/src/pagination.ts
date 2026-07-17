import { PAGINATION_MAX_LIMIT } from "@studafy/shared-schemas";

/**
 * Client-side pagination contract that keeps front-end list calls on the indexed, cursor-paginated
 * path the backend is built for. `limit` + `cursor` map to B-Tree-backed keyset pagination; `sort_by`
 * is constrained at the type level to a union of the operation's indexed columns, so a raw arbitrary
 * string cannot bypass an index. No list route exists yet — this is the contract those routes will
 * be generated against.
 */

/** Sort direction. Both directions are servable from a single B-Tree index. */
export type SortDirection = "asc" | "desc";

/**
 * Parameters every list-fetching call must supply. `SortBy` is the union of indexed column names for
 * a given operation (defaults to `never`, i.e. sorting is closed until an operation opts columns in).
 */
export interface ListParams<SortBy extends string = never> {
  /** Page size. Mandatory so a call cannot request an unbounded scan. */
  readonly limit: number;
  /** Opaque forward cursor. Absent on the first page. */
  readonly cursor?: string;
  /** Column to sort by. Restricted to the operation's indexed columns. */
  readonly sort_by?: SortBy;
  /** Sort direction; defaults server-side when omitted. */
  readonly sort_dir?: SortDirection;
}

/**
 * Runtime guard mirroring the compile-time {@link ListParams} contract, for values that arrive
 * untyped (URL query, form state). Throws {@link RangeError} on a limit outside `[1, MAX]`, an empty
 * cursor, or a `sort_by` outside the indexed columns.
 */
export function assertListParams<SortBy extends string>(
  // NoInfer pins SortBy to the allowed columns, so passing a `sort_by` outside them is a compile
  // error rather than silently widening the union to admit it.
  params: ListParams<NoInfer<SortBy>>,
  allowedSortColumns: readonly SortBy[],
): void {
  if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > PAGINATION_MAX_LIMIT) {
    throw new RangeError(
      `limit must be an integer between 1 and ${PAGINATION_MAX_LIMIT}; received ${String(params.limit)}.`,
    );
  }
  if (params.cursor !== undefined && params.cursor.length === 0) {
    throw new RangeError("cursor must be a non-empty opaque token when provided.");
  }
  if (params.sort_by !== undefined && !allowedSortColumns.includes(params.sort_by)) {
    throw new RangeError(
      `sort_by must be one of [${allowedSortColumns.join(", ")}]; received ${String(params.sort_by)}. ` +
        "Sorting is restricted to indexed columns.",
    );
  }
}
