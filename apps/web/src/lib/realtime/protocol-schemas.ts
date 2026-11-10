import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";
import { z } from "zod";

import { parseRoomKeyParts } from "./protocol";

import type {
  ClientMessage,
  EventEnvelope,
  IncomingMessage,
  RoomKey,
  SystemMessage,
} from "./protocol";

/**
 * The zod schemas for the realtime wire grammar, and the frame parser built on them. Kept apart
 * from protocol.ts so that zod is not on the path to the first paint: the client loads this module
 * while it fetches its handshake ticket, so it is always in place before the socket can deliver a
 * frame. Each schema is checked below against its type in protocol.ts, so the two cannot drift.
 */

/** `school:{schoolId}`, `school:{schoolId}:role:{ROLE}`, or `school:{schoolId}:user:{userId}`. */
export const roomKeySchema = z.string().refine((value) => parseRoomKeyParts(value) !== undefined, {
  message:
    "must be school:{schoolId}, school:{schoolId}:role:{ROLE}, or school:{schoolId}:user:{userId}",
});

/** Domain event envelope; see {@link EventEnvelope}. */
export const eventEnvelopeSchema = z.object({
  id: uuidSchema,
  type: z.string().min(1),
  room: roomKeySchema,
  payload: z.unknown(),
  publishedAt: dateTimeSchema,
});

/** Gateway -> client control messages; see {@link SystemMessage}. */
export const systemMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("system.joined"), room: roomKeySchema }),
  z.object({ type: z.literal("system.left"), room: roomKeySchema }),
  z.object({ type: z.literal("system.error"), message: z.string() }),
  z.object({ type: z.literal("system.reauth_required"), reason: z.string() }),
]);

/** Client -> gateway control messages; see {@link ClientMessage}. */
export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), room: roomKeySchema }),
  z.object({ type: z.literal("leave"), room: roomKeySchema }),
]);

// Compile-time proof that each schema accepts exactly its hand-written type in protocol.ts.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type ProtocolSchemasMatchTypes = [
  Assert<Equals<z.infer<typeof roomKeySchema>, RoomKey>>,
  Assert<Equals<z.infer<typeof eventEnvelopeSchema>, EventEnvelope>>,
  Assert<Equals<z.infer<typeof systemMessageSchema>, SystemMessage>>,
  Assert<Equals<z.infer<typeof clientMessageSchema>, ClientMessage>>,
];

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
