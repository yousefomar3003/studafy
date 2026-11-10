/**
 * Client-side mirror of the realtime gateway's wire grammar (`apps/realtime/src/protocol.ts`).
 * The gateway is the source of truth and validates everything it forwards; the schemas in
 * `protocol-schemas.ts` are the client's own defense against malformed or foreign frames, and are
 * intentionally kept in step with that module. See `apps/realtime/docs/protocol.md` for the
 * narrative spec.
 *
 * This module holds only the types and the helpers that need no validation library: the realtime
 * client is constructed on every page (signed out included), so anything imported here is on the
 * path to the first paint. The zod schemas live in `protocol-schemas.ts`, which the client loads
 * while it fetches its handshake ticket, before the socket opens.
 */

export type ParsedRoomKey =
  | { kind: "school"; schoolId: string }
  | { kind: "role"; schoolId: string; role: string }
  | { kind: "user"; schoolId: string; userId: string };

/**
 * Parses a room key by splitting on `:` rather than matching one regex (the gateway does the same
 * to dodge eslint's `security/detect-unsafe-regex` heuristic). The client validates structure
 * only — `school:{schoolId}`, `school:{schoolId}:role:{ROLE}`, or `school:{schoolId}:user:{userId}`
 * with non-empty segments. Whether a role is a real `@studafy/constants` ROLE is the gateway's
 * job; the client only needs to carry the key back and forth.
 */
export function parseRoomKeyParts(value: string): ParsedRoomKey | undefined {
  const parts = value.split(":");
  const [prefix, schoolId, kindSegment, id] = parts;
  if (prefix !== "school" || !schoolId) {
    return undefined;
  }
  if (parts.length === 2) {
    return { kind: "school", schoolId };
  }
  if (parts.length === 4 && kindSegment === "role" && id) {
    return { kind: "role", schoolId, role: id };
  }
  if (parts.length === 4 && kindSegment === "user" && id) {
    return { kind: "user", schoolId, userId: id };
  }
  return undefined;
}

/** `school:{schoolId}`, `school:{schoolId}:role:{ROLE}`, or `school:{schoolId}:user:{userId}`. */
export type RoomKey = string;

/**
 * Domain event envelope the gateway fans out verbatim from a room's Redis channel. `room` is the
 * room key it was delivered on; `payload` is arbitrary event-specific data the gateway does not
 * interpret. `id` is unique per publish and is what the client dedups on.
 */
export interface EventEnvelope {
  id: string;
  type: string;
  room: RoomKey;
  payload: unknown;
  publishedAt: string;
}

/**
 * Gateway -> client acks/errors for the control channel, distinct from domain event envelopes.
 * `system.reauth_required` always precedes a close with `REAUTH_REQUIRED_CLOSE_CODE`.
 */
export type SystemMessage =
  | { type: "system.joined"; room: RoomKey }
  | { type: "system.left"; room: RoomKey }
  | { type: "system.error"; message: string }
  | { type: "system.reauth_required"; reason: string };

/** Client -> gateway control messages: join/leave a room beyond the home rooms granted at handshake. */
export type ClientMessage = { type: "join"; room: RoomKey } | { type: "leave"; room: RoomKey };

/** Anything the gateway may send the client over the socket. */
export type IncomingMessage = SystemMessage | EventEnvelope;

/**
 * Narrowing helper: every system message carries a `system.*` type, while event envelopes carry a
 * domain-event name. The plain union can't be discriminated by literal `type` values (the
 * envelope's `type` is a loose `string`), so this predicate drives the client's message handling.
 */
export function isSystemMessage(message: IncomingMessage): message is SystemMessage {
  return message.type.startsWith("system.");
}

/** Close code the gateway uses when it closes a socket because its token expired mid-connection. */
export const REAUTH_REQUIRED_CLOSE_CODE = 4401;
