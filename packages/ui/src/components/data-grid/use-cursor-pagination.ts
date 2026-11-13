import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One page of a cursor-paginated list. Mirrors the wire contract's response side: an opaque
 * `nextCursor` forward token, absent on the last page. See `@studafy/shared-schemas`'
 * `paginationQuerySchema` for the matching request side (`{ limit, cursor? }`) — this package adds
 * no dependency on it, so the hook stays usable against any API that shape-matches.
 */
export interface CursorPage<TRow> {
  items: readonly TRow[];
  nextCursor?: string;
}

export type FetchCursorPage<TRow> = (cursor: string | undefined) => Promise<CursorPage<TRow>>;

export interface UseCursorPaginationResult<TRow> {
  items: readonly TRow[];
  loading: boolean;
  error: unknown;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  goToNextPage: () => void;
  goToPreviousPage: () => void;
}

/**
 * Drives a single page of a cursor-paginated list. `fetchPage`'s identity is the cache key —
 * memoize it with `useCallback` over whatever filters and sort state it captures; changing it
 * resets back to the first page.
 *
 * Cursors are forward-only (see the schema doc), so there is no server request that means
 * "go back". Instead this hook keeps a stack of the cursors it has already used to reach the
 * current page, and stepping backward pops it.
 */
export function useCursorPagination<TRow>(
  fetchPage: FetchCursorPage<TRow>,
): UseCursorPaginationResult<TRow> {
  const [page, setPage] = useState<CursorPage<TRow>>({ items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(undefined);

  const cursorHistory = useRef<(string | undefined)[]>([undefined]);
  const latestRequestId = useRef(0);

  const load = useCallback(
    (cursor: string | undefined) => {
      const requestId = latestRequestId.current + 1;
      latestRequestId.current = requestId;
      setLoading(true);
      setError(undefined);

      fetchPage(cursor).then(
        (result) => {
          if (latestRequestId.current === requestId) {
            setPage(result);
            setLoading(false);
          }
        },
        (reason: unknown) => {
          if (latestRequestId.current === requestId) {
            setError(reason);
            setLoading(false);
          }
        },
      );
    },
    [fetchPage],
  );

  useEffect(() => {
    cursorHistory.current = [undefined];
    load(undefined);
  }, [load]);

  const goToNextPage = useCallback(() => {
    if (!page.nextCursor) {
      return;
    }
    cursorHistory.current = [...cursorHistory.current, page.nextCursor];
    load(page.nextCursor);
  }, [load, page.nextCursor]);

  const goToPreviousPage = useCallback(() => {
    if (cursorHistory.current.length < 2) {
      return;
    }
    cursorHistory.current = cursorHistory.current.slice(0, -1);
    load(cursorHistory.current.at(-1));
  }, [load]);

  return {
    items: page.items,
    loading,
    error,
    hasNextPage: Boolean(page.nextCursor),
    hasPreviousPage: cursorHistory.current.length > 1,
    goToNextPage,
    goToPreviousPage,
  };
}
