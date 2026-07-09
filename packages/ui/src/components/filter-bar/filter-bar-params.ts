export interface DateRangeValue {
  /** ISO-8601 date (`YYYY-MM-DD`), the same format as `@studafy/shared-schemas`' `dateSchema`. */
  from?: string;
  to?: string;
}

export interface FilterBarState {
  search: string;
  dateRange: DateRangeValue;
  /** Ids of the active removable chips, e.g. selected facets from elsewhere on the page. */
  chipIds: readonly string[];
}

const SEARCH_PARAM = "q";
const DATE_FROM_PARAM = "from";
const DATE_TO_PARAM = "to";
const CHIPS_PARAM = "filters";

/**
 * FilterBar renders UI state only; it does not read or write the URL itself (that would make it a
 * routing concern, not a component one). These pure functions are what a page wires up to its own
 * router — `serializeFilterBarState(state)` produces the params to push, and
 * `parseFilterBarState(params)` reads them back on load.
 */
export function serializeFilterBarState(state: Partial<FilterBarState>): URLSearchParams {
  const params = new URLSearchParams();

  if (state.search) {
    params.set(SEARCH_PARAM, state.search);
  }
  if (state.dateRange?.from) {
    params.set(DATE_FROM_PARAM, state.dateRange.from);
  }
  if (state.dateRange?.to) {
    params.set(DATE_TO_PARAM, state.dateRange.to);
  }
  if (state.chipIds && state.chipIds.length > 0) {
    params.set(CHIPS_PARAM, state.chipIds.join(","));
  }

  return params;
}

export function parseFilterBarState(params: URLSearchParams): FilterBarState {
  const chipsParam = params.get(CHIPS_PARAM);

  return {
    search: params.get(SEARCH_PARAM) ?? "",
    dateRange: {
      from: params.get(DATE_FROM_PARAM) ?? undefined,
      to: params.get(DATE_TO_PARAM) ?? undefined,
    },
    chipIds: chipsParam ? chipsParam.split(",").filter(Boolean) : [],
  };
}
