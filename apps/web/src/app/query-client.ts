import { ApiError } from "@studafy/api-client";
import { QueryClient } from "@tanstack/react-query";

/** Creates the app's TanStack Query client with conservative defaults. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        // One retry for a network failure or a 5xx; none for a 4xx, which answers the same the
        // second time ("this grade isn't set up", "not found", "forbidden") and only held the page
        // on "Loading..." for the retry's delay before showing it.
        retry: (failureCount, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
          failureCount < 1,
      },
    },
  });
}
