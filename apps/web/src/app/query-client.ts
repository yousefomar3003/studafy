import { QueryClient } from "@tanstack/react-query";

/** Creates the app's TanStack Query client with conservative defaults. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}
