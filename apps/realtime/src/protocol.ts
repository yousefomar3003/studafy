import { ROLES } from "@studafy/constants";
import { z } from "zod";

/**
 * Realtime protocol: room naming, the event envelope fanned out from Redis, and the small
 * control-message vocabulary exchanged between client and gateway. See docs/protocol.md for the
 * narrative spec this module implements.
 */

/** Captures `[full, schoolId, role]` — exported so `rooms.ts` can parse a key without re-deriving the shape. */
export const ROOM_KEY_PATTERN = /^school:([^:]+):role:([A-Z_]+)$/;
const ROOM_ROLES: readonly string[] = Object.values(ROLES);

/** `school:{schoolId}:role:{ROLE}`, the one room-naming convention the whole gateway shares. */
export const roomKeySchema = z
  .string()
  .regex(ROOM_KEY_PATTERN, "must be school:{schoolId}:role:{ROLE}")
  .refine((value) => ROOM_ROLES.includes(value.match(ROOM_KEY_PATTERN)?.[2] ?? ""), {
    message: `role segment must be one of: ${ROOM_ROLES.join(", ")}`,
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

/** Gateway -> client acks/errors for the control channel — distinct from domain event envelopes. */
export const systemMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("system.joined"), room: roomKeySchema }),
  z.object({ type: z.literal("system.left"), room: roomKeySchema }),
  z.object({ type: z.literal("system.error"), message: z.string() }),
]);
export type SystemMessage = z.infer<typeof systemMessageSchema>;
