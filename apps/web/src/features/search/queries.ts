import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "../../lib/api";

import type { components } from "@studafy/api-client";

export type GlobalSearchResult = components["schemas"]["GlobalSearchResult"];
export type StudentSearchHit = components["schemas"]["StudentSearchHit"];
export type UserSearchHit = components["schemas"]["UserSearchHit"];
export type InvoiceSearchHit = components["schemas"]["InvoiceSearchHit"];
export type MaterialSearchHit = components["schemas"]["MaterialSearchHit"];

/**
 * Mirrors `SEARCH_QUERY_MIN_LENGTH` in `apps/api/src/modules/search/service.ts`. The web app and
 * API are separate deployables with no shared package for this one constant, so it's duplicated
 * here rather than imported -- gating the request client-side avoids firing (and audit-logging) a
 * guaranteed 400 on every one- or two-keystroke pause while typing.
 */
export const GLOBAL_SEARCH_MIN_QUERY_LENGTH = 2;

export const GLOBAL_SEARCH_QUERY_KEY = ["global-search"] as const;

/**
 * Role-scoped global search (`GET /api/search`), grouped per record type by the API itself. `q`
 * should already be trimmed and debounced by the caller (see `SearchPalette`); this hook only
 * decides whether it's long enough to run.
 *
 * `placeholderData: keepPreviousData` keeps the last result set on screen while a new keystroke's
 * query is in flight, the same choice `admin/users/UsersListPage` makes for its own search box --
 * without it, every debounced keystroke would blank the palette before showing anything.
 */
export function useGlobalSearchQuery(q: string) {
  return useQuery({
    queryKey: [...GLOBAL_SEARCH_QUERY_KEY, q],
    queryFn: async () => {
      const { data } = await api.GET("/api/search", { params: { query: { q } } });
      return data;
    },
    enabled: q.length >= GLOBAL_SEARCH_MIN_QUERY_LENGTH,
    placeholderData: keepPreviousData,
  });
}
