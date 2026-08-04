import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";
import { z } from "zod";

/**
 * Client-side mirror of the realtime gateway's wire grammar (`apps/realtime/src/protocol.ts`).
 * The gateway is the source of truth and validates everything it forwards; these schemas are the
 * client's own defense against malformed or foreign frames, and are intentionally kept in step
 * with that module. See `apps/realtime/docs/protocol.md` for the narrative spec.
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
export const roomKeySchema = z.string().refine((value) => parseRoomKeyParts(value) !== undefined, {
  message:
    "must be school:{schoolId}, school:{schoolId}:role:{ROLE}, or school:{schoolId}:user:{userId}",
});
export type RoomKey = z.infer<typeof roomKeySchema>;

/**
 * Domain event envelope the gateway fans out verbatim from a room's Redis channel. `room` is the
 * room key it was delivered on; `payload` is arbitrary event-specific data the gateway does not
 * interpret. `id` is unique per publish and is what the client dedups on.
 */
export const eventEnvelopeSchema = z.object({
  id: uuidSchema,
  type: z.string().min(1),
  room: roomKeySchema,
  payload: z.unknown(),
  publishedAt: dateTimeSchema,
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/**
 * Gateway -> client acks/errors for the control channel, distinct from domain event envelopes.
 * `system.reauth_required` always precedes a close with `REAUTH_REQUIRED_CLOSE_CODE`.
 */
export const systemMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("system.joined"), room: roomKeySchema }),
  z.object({ type: z.literal("system.left"), room: roomKeySchema }),
  z.object({ type: z.literal("system.error"), message: z.string() }),
  z.object({ type: z.literal("system.reauth_required"), reason: z.string() }),
]);
export type SystemMessage = z.infer<typeof systemMessageSchema>;

/** Client -> gateway control messages: join/leave a room beyond the home rooms granted at handshake. */
export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), room: roomKeySchema }),
  z.object({ type: z.literal("leave"), room: roomKeySchema }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

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

/**
 * Parses and validates a raw text frame from the gateway. Returns `undefined` for malformed
 * frames or JSON that isn't a known message shape — the client logs and drops those rather than
 * crashing, matching the gateway's own validate-and-drop behavior.
 *
 * The two shapes are tried separately rather than as one `discriminatedUnion`: Zod 4 rejects a
 * discriminated union whose options are themselves discriminated unions, and the gateway's
 * `systemMessageSchema` is exactly that. Order is safe because system messages all carry a
 * `system.*` type while event envelopes carry a domain-event name.
 */
export function parseIncomingMessage(text: string): IncomingMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const system = systemMessageSchema.safeParse(parsed);
  if (system.success) {
    return system.data;
  }
  const envelope = eventEnvelopeSchema.safeParse(parsed);
  return envelope.success ? envelope.data : undefined;
}
