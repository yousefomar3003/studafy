import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type PropsWithChildren } from "react";

import { getRealtimeToken, RealtimeClient, RealtimeProvider } from "../lib/realtime";

import { createQueryClient } from "./query-client";

/**
 * Composes all app-wide providers in one place. Add new context providers here so the rest of the
 * app never wires them directly. The query client is created once per app instance; the realtime
 * socket client is built against it so live events can invalidate server state (see
 * `src/lib/realtime/invalidations.ts`).
 */
export function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(createQueryClient);
  const [realtimeClient] = useState(
    () =>
      new RealtimeClient({
        baseUrl: import.meta.env.VITE_REALTIME_BASE_URL ?? "ws://localhost:3001",
        getToken: getRealtimeToken,
        queryClient,
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <RealtimeProvider client={realtimeClient}>{children}</RealtimeProvider>
    </QueryClientProvider>
  );
}
