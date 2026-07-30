import { DOMAIN_EVENTS } from "@studafy/constants";

import { eventPayloadSchemas } from "../../../lib/events/schemas";
import { invalidatePublishedGradeCache } from "../published/cache";

import type { Logger } from "../../../logger";
import type { RedisClient } from "../../../redis";

const CHANNEL_PATTERN = `events:*:${DOMAIN_EVENTS.GRADES_PUBLISHED}`;

export interface GradePublishedSubscriber {
  close(): Promise<void>;
}

export async function startGradePublishedSubscriber(options: {
  redis: RedisClient;
  logger: Logger;
}): Promise<GradePublishedSubscriber> {
  const { redis, logger } = options;
  const subscriber = redis.duplicate();
  const log = logger.child({ component: "grade-published-subscriber" });

  const onMessage = (pattern: string, channel: string, raw: string): void => {
    if (pattern !== CHANNEL_PATTERN) return;

    void (async () => {
      const segments = channel.split(":");
      if (
        segments.length !== 3 ||
        segments[0] !== "events" ||
        segments[2] !== DOMAIN_EVENTS.GRADES_PUBLISHED
      ) {
        log.warn({ channel }, "ignored malformed grades.published channel");
        return;
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch (err) {
        log.warn({ err, channel }, "ignored malformed grades.published payload");
        return;
      }

      const parsed = eventPayloadSchemas[DOMAIN_EVENTS.GRADES_PUBLISHED].safeParse(decoded);
      if (!parsed.success) {
        log.warn(
          { channel, issues: parsed.error.issues },
          "ignored invalid grades.published payload",
        );
        return;
      }

      const schoolId = segments[1]!;
      const deleted = await invalidatePublishedGradeCache(redis, schoolId, parsed.data.studentId);
      log.info(
        { school_id: schoolId, student_id: parsed.data.studentId, deleted },
        "invalidated published grades cache",
      );
    })().catch((err) => {
      log.error({ err, channel }, "grades.published cache invalidation failed");
    });
  };

  subscriber.on("pmessage", onMessage);
  await subscriber.psubscribe(CHANNEL_PATTERN);
  log.info({ pattern: CHANNEL_PATTERN }, "subscribed");

  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      subscriber.off("pmessage", onMessage);
      try {
        await subscriber.punsubscribe(CHANNEL_PATTERN);
      } finally {
        await subscriber.quit();
      }
    },
  };
}
