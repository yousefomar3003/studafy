import { DOMAIN_EVENTS } from "@studafy/constants";

import { eventPayloadSchemas } from "../../../lib/events/schemas";
import {
  aiEntitlementCacheKey,
  entitlementCacheKey,
  invalidateEntitlementEntry,
} from "../entitlements/cache";

import type { Logger } from "../../../logger";
import type { RedisClient } from "../../../redis";

/**
 * Entitlement cache invalidation over the outbox relay's pub/sub channels (ST-133).
 *
 * The fast path, not the guarantee. Redis pub/sub is fire-and-forget: the relay marks `relayed_at`
 * whether or not anyone was listening, so an API pod restarting mid-deploy loses the message
 * permanently. The durable guarantee is the workers-side poller
 * (apps/workers/src/queues/entitlements), which claims the same outbox rows through its own cursor
 * and cannot lose one.
 *
 * Running both is safe and deliberate. Both apply the identical version-guarded Lua, so whichever
 * arrives second is a provable no-op rather than a race — `invalidateEntitlementEntry` returns false
 * when the stored entry is already at or above the incoming version.
 *
 * Structurally a copy of modules/grades/subscribers/grade-published.subscriber.ts, including its two
 * load-bearing habits: a dedicated connection via `redis.duplicate()` (a subscribed client cannot run
 * ordinary commands), and never throwing out of the message handler.
 */

const SUBSCRIPTION_CHANNEL = `events:*:${DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED}`;
const AI_CHANNEL = `events:*:${DOMAIN_EVENTS.AI_SUBSCRIPTION_STATUS_CHANGED}`;

export interface EntitlementInvalidationSubscriber {
  close(): Promise<void>;
}

export async function startEntitlementInvalidationSubscriber(options: {
  redis: RedisClient;
  logger: Logger;
}): Promise<EntitlementInvalidationSubscriber> {
  const { redis, logger } = options;
  const subscriber = redis.duplicate();
  const log = logger.child({ component: "entitlement-invalidation-subscriber" });

  const onMessage = (pattern: string, channel: string, raw: string): void => {
    if (pattern !== SUBSCRIPTION_CHANNEL && pattern !== AI_CHANNEL) return;

    void (async () => {
      const segments = channel.split(":");
      const eventName = segments[2];
      if (segments.length !== 3 || segments[0] !== "events" || eventName === undefined) {
        log.warn({ channel }, "ignored malformed entitlement channel");
        return;
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch (err) {
        log.warn({ err, channel }, "ignored malformed entitlement payload");
        return;
      }

      if (eventName === DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED) {
        const parsed =
          eventPayloadSchemas[DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED].safeParse(decoded);
        if (!parsed.success) {
          log.warn(
            { channel, issues: parsed.error.issues },
            "ignored invalid subscription payload",
          );
          return;
        }

        const moved = await invalidateEntitlementEntry(
          redis,
          entitlementCacheKey(parsed.data.schoolId),
          parsed.data.entitlementsVersion,
        );
        log.info(
          { school_id: parsed.data.schoolId, version: parsed.data.entitlementsVersion, moved },
          "invalidated school entitlement",
        );
        return;
      }

      if (eventName === DOMAIN_EVENTS.AI_SUBSCRIPTION_STATUS_CHANGED) {
        const parsed =
          eventPayloadSchemas[DOMAIN_EVENTS.AI_SUBSCRIPTION_STATUS_CHANGED].safeParse(decoded);
        if (!parsed.success) {
          log.warn({ channel, issues: parsed.error.issues }, "ignored invalid ai payload");
          return;
        }

        const moved = await invalidateEntitlementEntry(
          redis,
          aiEntitlementCacheKey(parsed.data.studentId),
          parsed.data.entitlementsVersion,
        );
        log.info(
          { student_id: parsed.data.studentId, version: parsed.data.entitlementsVersion, moved },
          "invalidated ai entitlement",
        );
      }
    })().catch((err) => {
      log.error({ err, channel }, "entitlement cache invalidation failed");
    });
  };

  subscriber.on("pmessage", onMessage);
  await subscriber.psubscribe(SUBSCRIPTION_CHANNEL, AI_CHANNEL);
  log.info({ patterns: [SUBSCRIPTION_CHANNEL, AI_CHANNEL] }, "subscribed");

  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      subscriber.off("pmessage", onMessage);
      try {
        await subscriber.punsubscribe(SUBSCRIPTION_CHANNEL, AI_CHANNEL);
      } finally {
        await subscriber.quit();
      }
    },
  };
}
