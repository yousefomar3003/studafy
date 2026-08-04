import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";

import { RealtimeClient } from "./client";

import type { RealtimeConnectionStatus } from "./client";

const RealtimeContext = createContext<RealtimeClient | null>(null);

/**
 * Provides the app-wide {@link RealtimeClient} and owns its lifecycle: connects on mount and
 * disconnects on unmount. `connect`/`disconnect` are idempotent, so React 18 StrictMode's
 * double-invoke is safe. Mount this under `QueryClientProvider` — the client invalidates through
 * the `QueryClient` it was constructed with.
 */
export function RealtimeProvider({
  client,
  children,
}: PropsWithChildren<{ client: RealtimeClient }>) {
  useEffect(() => {
    client.connect();
    return () => client.disconnect();
  }, [client]);

  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}

/** Returns the app-wide {@link RealtimeClient}. Throws outside a `RealtimeProvider`. */
export function useRealtime(): RealtimeClient {
  const client = useContext(RealtimeContext);
  if (client === null) {
    throw new Error("useRealtime must be used within a RealtimeProvider");
  }
  return client;
}

/**
 * Subscribes the component to the realtime connection status for a connection-state indicator
 * (e.g. a "live"/"reconnecting" chip). Re-renders only on status transitions because
 * `getStatus` returns a stable primitive snapshot.
 */
export function useRealtimeConnection(): RealtimeConnectionStatus {
  const client = useRealtime();
  const subscribe = useMemo(() => client.subscribe.bind(client), [client]);
  const getStatus = useMemo(() => client.getStatus.bind(client), [client]);
  return useSyncExternalStore(subscribe, getStatus);
}
