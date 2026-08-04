import { ROLES } from "@studafy/constants";
import { z } from "zod";

/**
 * Realtime protocol: room naming, the event envelope fanned out from Redis, and the small
 * control-message vocabulary exchanged between client and gateway. See docs/protocol.md for the
 * narrative spec this module implements.
 */

const ROOM_ROLES = new Set<string>(Object.values(ROLES));

export type ParsedRoomKey =
  | { kind: "school"; schoolId: string }
  | { kind: "role"; schoolId: string; role: string }
  | { kind: "user"; schoolId: string; userId: string };

/**
 * Parses and validates a room key by splitting on `:` rather than matching one regex. Three room
 * kinds share the `school:{schoolId}` prefix (the multi-tenancy boundary): the bare school room,
 * a role room, and a per-user room. A single regex covering all three needs two `+`-quantified
 * groups in sequence, which trips eslint's `security/detect-unsafe-regex` heuristic even though
 * each group is unambiguously anchored by a distinct literal separator — splitting sidesteps that
 * false positive and is arguably easier to follow besides. Exported so `rooms.ts`'s `parseRoomKey`
 * doesn't re-derive this shape, and so `roomKeySchema` below can validate against it directly.
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
  if (parts.length === 4 && kindSegment === "role" && id && ROOM_ROLES.has(id)) {
    return { kind: "role", schoolId, role: id };
  }
  if (parts.length === 4 && kindSegment === "user" && id) {
    return { kind: "user", schoolId, userId: id };
  }
  return undefined;
}

/** `school:{schoolId}`, `school:{schoolId}:role:{ROLE}`, or `school:{schoolId}:user:{userId}`. */
export const roomKeySchema = z.string().refine((value) => parseRoomKeyParts(value) !== undefined, {
  message:
    "must be school:{schoolId}, school:{schoolId}:role:{ROLE}, or school:{schoolId}:user:{userId}",
});
export type RoomKey = z.infer<typeof roomKeySchema>;

/**
 * Domain event envelope: what publishers write to a room's Redis channel and what the gateway
 * fans out verbatim to every member of that room. `room` doubles as the Redis channel name.
 */
export const eventEnvelopeSchema = z.object({
  id: z.uuid(),
  type: z.string().min(1),
  room: roomKeySchema,
  payload: z.unknown(),
  publishedAt: z.iso.datetime(),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Client -> gateway control messages: join/leave a room beyond the one granted at handshake. */
export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), room: roomKeySchema }),
  z.object({ type: z.literal("leave"), room: roomKeySchema }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/**
 * Gateway -> client acks/errors for the control channel — distinct from domain event envelopes.
 * `system.reauth_required` is the re-auth protocol's signal: sent immediately before the gateway
 * closes the socket with close code 4401 because the connection's token reached its `exp` while
 * the socket was still open. It is not a rejection of the current message — the client should
 * obtain a fresh token and reconnect, not treat it as fatal the way `system.error` usually is.
 */
export const systemMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("system.joined"), room: roomKeySchema }),
  z.object({ type: z.literal("system.left"), room: roomKeySchema }),
  z.object({ type: z.literal("system.error"), message: z.string() }),
  z.object({ type: z.literal("system.reauth_required"), reason: z.string() }),
]);
export type SystemMessage = z.infer<typeof systemMessageSchema>;

/** Close code the gateway uses when it closes a socket because its token expired mid-connection. */
export const REAUTH_REQUIRED_CLOSE_CODE = 4401;
