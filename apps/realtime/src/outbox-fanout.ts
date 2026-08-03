import { ROUTED_EVENT_NAMES, routesFor } from "./event-routing";
import { incrementDropped, incrementReceived, incrementRoomDeliveries } from "./metrics";

import type { EventEnvelope } from "./protocol";
import type IORedis from "ioredis";

const CHANNEL_PREFIX = "events";

function channelPattern(eventName: string): string {
  return `${CHANNEL_PREFIX}:*:${eventName}`;
}

export type EnvelopeHandler = (envelope: EventEnvelope) => void;

/**
 * Bridges the outbox-relay worker's Redis channels (`events:{schoolId}:{event_name}`, plain
 * pub/sub `PUBLISH` — see apps/workers/src/queues/outbox-relay/relay.ts) into the gateway's room
 * fan-out. Issues one `PSUBSCRIBE events:*:{event_name}` per routed event name (src/event-routing.ts)
 * — the same idiom apps/api's own outbox subscribers use (e.g.
 * apps/api/src/modules/grades/subscribers/grade-published.subscriber.ts) — so an event type with
 * no route is never received at all, rather than received and dropped.
 *
 * The outbox relay never wraps its publish in an envelope: the raw outbox row payload is the
 * message body, with `schoolId`/`event_name` living only in the channel name. This is the one
 * place that builds the {@link EventEnvelope} the rest of the gateway understands — one per target
 * room, with a fresh id and publishedAt — and it forwards the payload unchanged (see
 * src/event-routing.ts for why that is safe: only ids-only events get a route).
 *
 * Takes its own Redis connection (a subscribed client cannot run ordinary commands) so its pattern
 * subscriptions never interleave with src/subscriber.ts's `school:*:role:*` ones on the same
 * connection. Returns a teardown function that removes the listener and unsubscribes.
 */
export function subscribeToOutboxEvents(
  redis: IORedis,
  onEnvelope: EnvelopeHandler,
): () => Promise<void> {
  const patterns = ROUTED_EVENT_NAMES.map(channelPattern);
  const patternSet = new Set(patterns);

  const listener = (pattern: string, channel: string, message: string) => {
    if (!patternSet.has(pattern)) {
      return;
    }

    const segments = channel.split(":");
    const [prefix, schoolId, eventName] = segments;
    if (segments.length !== 3 || prefix !== CHANNEL_PREFIX || !schoolId || !eventName) {
      console.warn(`[realtime] discarding malformed outbox channel "${channel}"`);
      incrementDropped();
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(message);
    } catch {
      console.warn(`[realtime] discarding non-JSON outbox message on channel "${channel}"`);
      incrementDropped();
      return;
    }

    // Guaranteed by patternSet: it only admits channels whose event-name segment is one of
    // ROUTED_EVENT_NAMES, so this route always exists.
    const route = routesFor(eventName);
    if (!route) {
      return;
    }

    incrementReceived();
    const publishedAt = new Date().toISOString();
    const rooms = route(schoolId);
    for (const room of rooms) {
      onEnvelope({ id: crypto.randomUUID(), type: eventName, room, payload, publishedAt });
    }
    incrementRoomDeliveries(rooms.length);
  };

  redis.on("pmessage", listener);
  if (patterns.length > 0) {
    void redis.psubscribe(...patterns);
  }

  return async () => {
    redis.off("pmessage", listener);
    if (patterns.length > 0) {
      await redis.punsubscribe(...patterns);
    }
  };
}
