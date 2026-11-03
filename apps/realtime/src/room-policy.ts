import { parseRoomKeyParts } from "./protocol";

import type { AuthClaims } from "./auth";
import type { ParsedRoomKey } from "./protocol";

/**
 * Room authorization (F-04). Who may join or leave a room is decided per room kind, by the table
 * below — never by the tenant check alone. Before this, any socket could join
 * `school:<own>:user:<anyone>` or `school:<own>:role:<any role>` and receive that user's or role's
 * events, because the gateway only compared `schoolId`.
 *
 * Every kind starts with the tenant boundary (the room's `schoolId` must be the caller's), then
 * adds its own rule. A new room kind must add a row here: `authorizeRoom` denies any kind without
 * one, so forgetting the row fails closed rather than falling back to "same school is enough".
 */

export type RoomKind = ParsedRoomKey["kind"];

type RoomPolicy<K extends RoomKind> = (
  room: Extract<ParsedRoomKey, { kind: K }>,
  claims: AuthClaims,
) => boolean;

export const ROOM_POLICIES: { readonly [K in RoomKind]: RoomPolicy<K> } = {
  /** Every connection in the tenant: any member of the school. */
  school: (room, claims) => room.schoolId === claims.schoolId,
  /** One role's connections: only a holder of that role. */
  role: (room, claims) => room.schoolId === claims.schoolId && room.role === claims.role,
  /** One user's connections: only that user. */
  user: (room, claims) => room.schoolId === claims.schoolId && room.userId === claims.userId,
};

export type RoomDecision = { allowed: true } | { allowed: false; reason: string };

export const OUTSIDE_SCHOOL_REASON = "cannot join a room outside your own school";
export const NOT_AUTHORIZED_REASON = "not authorized for this room";
export const UNKNOWN_KIND_REASON = "unknown room kind";

/** Decides whether `claims` may join (or leave) `room`. Unparseable keys and unknown kinds are denied. */
export function authorizeRoom(room: string, claims: AuthClaims): RoomDecision {
  const parsed = parseRoomKeyParts(room);
  if (!parsed || !Object.hasOwn(ROOM_POLICIES, parsed.kind)) {
    return { allowed: false, reason: UNKNOWN_KIND_REASON };
  }
  if (parsed.schoolId !== claims.schoolId) {
    return { allowed: false, reason: OUTSIDE_SCHOOL_REASON };
  }
  const policy = ROOM_POLICIES[parsed.kind] as RoomPolicy<RoomKind>;
  return policy(parsed, claims)
    ? { allowed: true }
    : { allowed: false, reason: NOT_AUTHORIZED_REASON };
}
