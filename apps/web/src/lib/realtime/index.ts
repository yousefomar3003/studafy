/**
 * Realtime client library: a shared WebSocket connection to the `apps/realtime` gateway with
 * token auth, jittered-backoff reconnects, and a TanStack Query invalidation map.
 *
 * - {@link RealtimeClient} — the framework-agnostic socket client.
 * - {@link RealtimeProvider} / {@link useRealtimeConnection} — React integration and the
 *   connection-state UI hook.
 * - {@link EVENT_QUERY_INVALIDATIONS} — the event -> query-key map.
 */
export { RealtimeClient } from "./client";
export type { RealtimeClientOptions, RealtimeConnectionStatus, RealtimeSocket } from "./client";

export { RealtimeProvider, useRealtime, useRealtimeConnection } from "./connection";

export { getRealtimeToken } from "./token";

export {
  EVENT_QUERY_INVALIDATIONS,
  allInvalidationKeys,
  invalidationKeysFor,
} from "./invalidations";
