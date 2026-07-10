import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type PropsWithChildren } from "react";

import { createQueryClient } from "./query-client";

/**
 * Composes all app-wide providers in one place. Add new context providers here so the rest of the
 * app never wires them directly. The query client is created once per app instance.
 */
export function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(createQueryClient);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
