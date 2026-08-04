import type { QueryKey } from "@tanstack/react-query";

/**
 * Event -> TanStack Query invalidation map. Keyed by the wire `EventEnvelope.type` (a free
 * string), mapped to the query-key prefixes that event invalidates. This is the client-side
 * counterpart to `apps/realtime/src/event-routing.ts`'s `EVENT_ROUTES`: that module decides which
 * rooms an event fans out to, this one decides which server state a received event invalidates.
 * Add an entry here alongside a gateway route — an event with no route never reaches the client,
 * and an event with a route but no entry here is only ever refetched on the next reconnect.
 *
 * `invalidateQueries` matches prefixes, so `["approval-queue"]` invalidates any query whose key
 * starts with that segment (e.g. `["approval-queue"]` for the badge count, or
 * `["approval-queue", "submissions"]` for a list page).
 *
 * A `Map` (not a plain object) so an arbitrary wire string — e.g. `"constructor"` or
 * `"__proto__"` — can never resolve a prototype member and is just "no mapping".
 */
export const EVENT_QUERY_INVALIDATIONS: ReadonlyMap<string, readonly QueryKey[]> = new Map([
  // A grade submission being published resolves its pending item in the approval queue and
  // changes grade visibility for the involved student/parent (the gateway's only routed event).
  ["grades.published", [["approval-queue"], ["grades"]]],
]);

/** Query-key prefixes to invalidate for a given event name. Empty when the event maps to nothing. */
export function invalidationKeysFor(eventName: string): readonly QueryKey[] {
  return EVENT_QUERY_INVALIDATIONS.get(eventName) ?? [];
}

/**
 * Every query-key prefix in the map, in map order. Used on a successful reconnect to reconcile
 * state that may have changed while the socket was down.
 */
export function allInvalidationKeys(): readonly QueryKey[] {
  return [...EVENT_QUERY_INVALIDATIONS.values()].flat();
}
