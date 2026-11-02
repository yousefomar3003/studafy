import { DOMAIN_EVENTS, ROLES } from "@studafy/constants";

import { roleRoomKey, userRoomKey } from "./rooms";

import type { RoomKey } from "./protocol";
import type { DomainEvent } from "@studafy/constants";

/**
 * Which rooms an outbox-relayed domain event fans out to, given the school it occurred in. See
 * docs/event-routing.md for the narrative table this implements.
 *
 * A route derives rooms from `schoolId` alone and always targets role rooms
 * (`school:{schoolId}:role:{ROLE}`, src/rooms.ts's `roleRoomKey`) — even though the gateway also
 * has school-wide and per-user rooms, so this is role-wide broadcast, not per-recipient delivery.
 * A client filters for itself out of the payload's resource ids (e.g. its
 * own studentId); the outbox payload already carries only those ids
 * (apps/api/src/lib/events/schemas.ts), so src/outbox-fanout.ts forwards it unchanged rather than
 * reshaping it. Only add an event here once its outbox payload schema is known to carry ids and
 * not row data — the routing table is what makes that guarantee, not anything the gateway checks
 * at runtime.
 */
export type EventRoute = (schoolId: string, payload: unknown) => RoomKey[];

/** The `userId` an outbox payload names, when it is a non-empty string. */
function payloadUserId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const userId = (payload as { userId?: unknown }).userId;
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

export const EVENT_ROUTES: Partial<Record<DomainEvent, EventRoute>> = {
  [DOMAIN_EVENTS.GRADES_PUBLISHED]: (schoolId) => [
    roleRoomKey(schoolId, ROLES.STUDENT),
    roleRoomKey(schoolId, ROLES.PARENT),
  ],
  // A person's feature grants changed -- a seat assigned or freed, a license activated or ended
  // (docs/billing/feature-licensing.md). Per-recipient, unlike the role broadcasts: only that
  // person's own sockets (their home user room) hear it, and they re-read GET /api/me/features.
  [DOMAIN_EVENTS.USER_ENTITLEMENT_CHANGED]: (schoolId, payload) => {
    const userId = payloadUserId(payload);
    return userId ? [userRoomKey(schoolId, userId)] : [];
  },
};

/** Every domain event with a route — src/outbox-fanout.ts issues one PSUBSCRIBE per name. */
export const ROUTED_EVENT_NAMES = Object.keys(EVENT_ROUTES) as DomainEvent[];

export function routesFor(eventName: string): EventRoute | undefined {
  return EVENT_ROUTES[eventName as DomainEvent];
}
