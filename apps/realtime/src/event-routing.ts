import { DOMAIN_EVENTS, ROLES } from "@studafy/constants";

import { roomKey } from "./rooms";

import type { RoomKey } from "./protocol";
import type { DomainEvent } from "@studafy/constants";

/**
 * Which rooms an outbox-relayed domain event fans out to, given the school it occurred in. See
 * docs/event-routing.md for the narrative table this implements.
 *
 * A route derives rooms from `schoolId` alone — the gateway's one room dimension is
 * `school:{schoolId}:role:{ROLE}` (src/protocol.ts), so this is role-wide broadcast, not
 * per-recipient delivery. A client filters for itself out of the payload's resource ids (e.g. its
 * own studentId); the outbox payload already carries only those ids
 * (apps/api/src/lib/events/schemas.ts), so src/outbox-fanout.ts forwards it unchanged rather than
 * reshaping it. Only add an event here once its outbox payload schema is known to carry ids and
 * not row data — the routing table is what makes that guarantee, not anything the gateway checks
 * at runtime.
 */
export type EventRoute = (schoolId: string) => RoomKey[];

export const EVENT_ROUTES: Partial<Record<DomainEvent, EventRoute>> = {
  [DOMAIN_EVENTS.GRADES_PUBLISHED]: (schoolId) => [
    roomKey(schoolId, ROLES.STUDENT),
    roomKey(schoolId, ROLES.PARENT),
  ],
};

/** Every domain event with a route — src/outbox-fanout.ts issues one PSUBSCRIBE per name. */
export const ROUTED_EVENT_NAMES = Object.keys(EVENT_ROUTES) as DomainEvent[];

export function routesFor(eventName: string): EventRoute | undefined {
  return EVENT_ROUTES[eventName as DomainEvent];
}
