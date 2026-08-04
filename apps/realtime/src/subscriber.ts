import { eventEnvelopeSchema } from "./protocol";

import type { EventEnvelope } from "./protocol";
import type IORedis from "ioredis";

/**
 * Matches every room channel with one pattern subscription: the school-wide room
 * (`school:{schoolId}`), role rooms (`school:{schoolId}:role:{ROLE}`), and user rooms
 * (`school:{schoolId}:user:{userId}`) all share the `school:` prefix, and Redis's glob `*` spans
 * `:` like any other character, so a single `school:*` pattern covers all three.
 */
const ROOM_CHANNEL_PATTERN = "school:*";

export type EnvelopeHandler = (envelope: EventEnvelope) => void;

/**
 * Subscribes to every room's channel via a single `PSUBSCRIBE`, validates each message as an
 * {@link EventEnvelope}, and forwards valid ones to `onMessage`. A single pattern subscription
 * (rather than a per-room `SUBSCRIBE`/`UNSUBSCRIBE` as clients join and leave) means fan-out never
 * races a room's membership changes — the gateway is always listening to every room's channel.
 *
 * Malformed or non-matching messages are logged and dropped rather than crashing the gateway: a
 * bad publish from one producer must not take down delivery for every other room.
 *
 * Returns a teardown function that removes the listener and unsubscribes.
 */
export function subscribeToRooms(redis: IORedis, onMessage: EnvelopeHandler): () => Promise<void> {
  const listener = (_pattern: string, channel: string, message: string) => {
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      console.warn(`[realtime] discarding non-JSON message on channel "${channel}"`);
      return;
    }

    const parsed = eventEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(
        `[realtime] discarding invalid envelope on channel "${channel}": ${parsed.error.message}`,
      );
      return;
    }

    if (parsed.data.room !== channel) {
      console.warn(
        `[realtime] envelope room "${parsed.data.room}" does not match channel "${channel}", discarding`,
      );
      return;
    }

    onMessage(parsed.data);
  };

  redis.on("pmessage", listener);
  void redis.psubscribe(ROOM_CHANNEL_PATTERN);

  return async () => {
    redis.off("pmessage", listener);
    await redis.punsubscribe(ROOM_CHANNEL_PATTERN);
  };
}
