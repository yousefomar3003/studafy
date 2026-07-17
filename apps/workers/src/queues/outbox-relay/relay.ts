import IORedis from "ioredis";

import { claimBatch } from "./claim";
import { incrementFailed, incrementPublished, recordLag } from "./metrics";

import type { Sql } from "postgres";

/**
 * Relay configuration. All tunables in one place — no magic numbers scattered through the loop.
 */
export interface RelayConfig {
  /** Max rows to claim per school per poll cycle. */
  batchSize: number;
  /** Milliseconds to sleep when an entire poll cycle finds zero unrelayed rows. */
  pollIntervalMs: number;
  /** Schools to relay for. Queried once at startup; refresh by restarting the process. */
  schoolIds: string[];
}

export interface RelayLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

interface RelayContext {
  db: Sql;
  redis: IORedis;
  config: RelayConfig;
  logger: RelayLogger;
}

export interface RelayHandle {
  stop(): void;
}

/**
 * Claim, relay, and mark one batch for a single school. Runs inside one database transaction so
 * row locks from SKIP LOCKED are held for the duration, preventing concurrent relayers from
 * double-claiming.
 */
async function relayBatch(ctx: RelayContext, schoolId: string): Promise<number> {
  return await ctx.db.begin(async (tx) => {
    const { rows } = await claimBatch(tx, schoolId, ctx.config.batchSize);
    if (rows.length === 0) return 0;

    for (const row of rows) {
      const channel = `events:${row.school_id}:${row.event_name}`;
      await ctx.redis.publish(channel, JSON.stringify(row.payload));

      const lagMs = Date.now() - new Date(row.created_at).getTime();
      recordLag(lagMs);
    }

    incrementPublished(rows.length);

    const now = new Date().toISOString();
    await tx`UPDATE app.outbox_events SET relayed_at = ${now} WHERE id = ANY(${rows.map((r) => r.id)})`;

    return rows.length;
  });
}

/**
 * One full poll cycle across all configured schools. Returns the total number of events relayed
 * in this cycle.
 */
async function pollOnce(ctx: RelayContext): Promise<number> {
  let total = 0;
  for (const schoolId of ctx.config.schoolIds) {
    try {
      const count = await relayBatch(ctx, schoolId);
      total += count;
    } catch (err) {
      incrementFailed();
      ctx.logger.error({ err, school_id: schoolId }, "batch relay failed");
    }
  }
  return total;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main relay loop. Claims batches via SKIP LOCKED, publishes to Redis pub/sub, marks relayed_at.
 * Runs until `stop()` is called.
 *
 * Two concurrent relayers never double-publish beyond at-least-once: SKIP LOCKED ensures each row
 * is claimed by exactly one relayer. If the claiming transaction crashes before commit, the locks
 * release and the row stays unrelayed — picked up on the next cycle.
 */
export function startRelay(ctx: RelayContext): RelayHandle {
  let stopped = false;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const count = await pollOnce(ctx);
        if (count === 0) {
          await sleep(ctx.config.pollIntervalMs);
        }
      } catch (err) {
        incrementFailed();
        ctx.logger.error({ err }, "relay cycle failed");
        await sleep(ctx.config.pollIntervalMs);
      }
    }
  };

  ctx.logger.info(
    { schools: ctx.config.schoolIds.length, batchSize: ctx.config.batchSize },
    "outbox relay started",
  );
  void loop();

  return {
    stop: () => {
      stopped = true;
      ctx.logger.info({}, "outbox relay stopping");
    },
  };
}
