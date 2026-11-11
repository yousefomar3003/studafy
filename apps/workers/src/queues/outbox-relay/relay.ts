import IORedis from "ioredis";

import { withSystemTenantTx } from "../../db/tenant-tx";
import { discoverPendingSchools } from "../outbox-discovery";
import { startPollLoop } from "../poll-loop";

import { claimBatch } from "./claim";
import { incrementFailed, incrementPublished, recordLag } from "./metrics";

import type { Sql } from "postgres";

/**
 * Relay configuration. All tunables in one place — no magic numbers scattered through the loop.
 */
export interface RelayConfig {
  /** Max rows to claim per school per poll cycle. */
  batchSize: number;
  /** Milliseconds to sleep after the first poll cycle that finds zero unrelayed rows. */
  pollIntervalMs: number;
  /**
   * The ceiling the idle sleep doubles up to while cycles keep finding nothing (see poll-loop.ts).
   * Defaults to `pollIntervalMs`, i.e. no backoff.
   */
  maxIdleIntervalMs?: number;
  /**
   * Schools to relay for, or `null` for every school.
   *
   * `null` is the normal deployment. An explicit list is an override for tests and for pinning a
   * relay to a subset of tenants; it was previously the only source, which meant the relay silently
   * did not start when the variable was unset — the state it has been in in production.
   *
   * Either way, each cycle asks `app.outbox_pending_school_ids('relay')` which schools have
   * unrelayed rows and opens a claim transaction only for those (an explicit list narrows that
   * answer). A newly registered school is therefore relayed without a worker restart, and an idle
   * cycle is one statement rather than one transaction per school.
   */
  schoolIds: string[] | null;
}

export interface RelayLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

export interface RelayContext {
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
 *
 * A system tenant transaction, like the entitlement invalidator's and the email dispatcher's: tenant
 * isolation is armed for this school, so the claim no longer depends on the login role bypassing
 * RLS (the services' current `postgres` login does; the dedicated NOBYPASSRLS login that
 * docs/security/S-01-database-role-verification.md plans would not).
 */
async function relayBatch(ctx: RelayContext, schoolId: string): Promise<number> {
  return await withSystemTenantTx(ctx.db, { schoolId }, async (tx) => {
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
 * One full poll cycle across the schools that have unrelayed rows. Returns the total number of
 * events relayed in this cycle. Exported for tests.
 */
export async function pollOnce(ctx: RelayContext): Promise<number> {
  let total = 0;
  const pending = await discoverPendingSchools(ctx.db, "relay");
  const configured = ctx.config.schoolIds === null ? null : new Set(ctx.config.schoolIds);
  const schoolIds = configured ? pending.filter((id) => configured.has(id)) : pending;
  for (const schoolId of schoolIds) {
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

/**
 * Main relay loop. Claims batches via SKIP LOCKED, publishes to Redis pub/sub, marks relayed_at.
 * Runs until `stop()` is called.
 *
 * Two concurrent relayers never double-publish beyond at-least-once: SKIP LOCKED ensures each row
 * is claimed by exactly one relayer. If the claiming transaction crashes before commit, the locks
 * release and the row stays unrelayed — picked up on the next cycle.
 */
export function startRelay(ctx: RelayContext): RelayHandle {
  const loop = startPollLoop({
    minIdleMs: ctx.config.pollIntervalMs,
    maxIdleMs: ctx.config.maxIdleIntervalMs ?? ctx.config.pollIntervalMs,
    cycle: () => pollOnce(ctx),
    onError: (err) => {
      incrementFailed();
      ctx.logger.error({ err }, "relay cycle failed");
    },
  });

  ctx.logger.info(
    {
      schools: ctx.config.schoolIds?.length ?? "discovered per cycle",
      batchSize: ctx.config.batchSize,
    },
    "outbox relay started",
  );

  return {
    stop: () => {
      loop.stop();
      ctx.logger.info({}, "outbox relay stopping");
    },
  };
}
