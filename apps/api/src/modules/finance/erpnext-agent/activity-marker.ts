/**
 * Finance activity and wake marker (docs/plans/erpnext-fly.md).
 *
 * Each school's ERPNext site starts asleep (its scheduler disabled), and the site agent puts a site
 * back to sleep after 30 days without finance activity. This is the other half: when a finance
 * request builds a school's ERPNext client, record the activity and, if the site is asleep, ask the
 * agent to wake it. REST calls work while a site sleeps -- only ERPNext's periodic jobs need the
 * scheduler -- so the request never waits for the wake.
 *
 * Three properties matter more than the write itself:
 *
 *   - **Throttled.** One write per school per hour, through `SET NX EX` on a Redis key, so a busy
 *     school does not turn its site row into a hot row.
 *   - **Fail open.** A Redis or database failure is logged and dropped; it never reaches the finance
 *     request. When the write fails after the key was taken, the key is released (best effort) so
 *     the next request tries again instead of waiting out the hour.
 *   - **Its own short transaction, never awaited by the request.** The request's transaction may
 *     hold this very row locked (the credential resolver marks a ready site 'completed' in it), so
 *     waiting on the marker from inside that transaction would wait on itself. Run on the side, the
 *     update simply queues behind the request's commit, bounded by a lock timeout, and no
 *     transaction stays open across the ERPNext call.
 */

import { withTenantTx } from "../../../db/tenant-tx";

import type { Database, DatabasePools } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { RedisClient } from "../../../redis";

/** At most one activity write per school per this many seconds. */
export const FINANCE_ACTIVITY_THROTTLE_SECONDS = 3600;

/** Redis key holding a school's activity throttle. */
export function financeActivityKey(schoolId: string): string {
  return `erpnext:activity:${schoolId}`;
}

/** The narrow slice of Redis the marker uses, so tests can hand it a failing fake. */
export type ActivityMarkerRedis = Pick<RedisClient, "set" | "del">;

export interface FinanceActivityMarkerOptions {
  database: Database | DatabasePools;
  redis: ActivityMarkerRedis;
  logger: Logger;
}

export class FinanceActivityMarker {
  private readonly database: Database | DatabasePools;
  private readonly redis: ActivityMarkerRedis;
  private readonly logger: Logger;

  constructor(options: FinanceActivityMarkerOptions) {
    this.database = options.database;
    this.redis = options.redis;
    this.logger = options.logger;
  }

  /**
   * Record finance activity for `schoolId`, at most once an hour. Never rejects; callers fire and
   * forget it. Resolves to whether the row was written (for tests).
   */
  async mark(schoolId: string): Promise<boolean> {
    const key = financeActivityKey(schoolId);

    let acquired: boolean;
    try {
      acquired =
        (await this.redis.set(key, "1", "EX", FINANCE_ACTIVITY_THROTTLE_SECONDS, "NX")) === "OK";
    } catch (err) {
      // Without the throttle every finance request would write the row, so skip rather than write.
      this.logger.warn({ err, school_id: schoolId }, "finance activity throttle unavailable");
      return false;
    }
    if (!acquired) return false;

    try {
      await withTenantTx(this.database, { schoolId }, async (tx) => {
        // Queue behind the request's own transaction if it holds the row, but not indefinitely.
        await tx`SET LOCAL lock_timeout = '5s'`;
        // updated_at is left alone on purpose: the agent's pending list retries a failed site 10
        // minutes after its updated_at, and this is not a change to the site's provisioning.
        await tx`
          UPDATE app.erpnext_site_configs
          SET last_finance_activity_at = now(),
              wake_requested_at = CASE
                WHEN scheduler_enabled = false AND site_created_at IS NOT NULL THEN now()
                ELSE wake_requested_at
              END
          WHERE school_id = ${schoolId}::uuid
        `;
      });
      return true;
    } catch (err) {
      this.logger.warn({ err, school_id: schoolId }, "finance activity marker failed");
      try {
        await this.redis.del(key);
      } catch {
        // The key expires on its own within the hour.
      }
      return false;
    }
  }
}
