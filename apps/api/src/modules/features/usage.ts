import { withTenantTx } from "../../db/tenant-tx";

import { usagePeriodStart } from "./resolve";

import type { Database, DatabasePools } from "../../db/client";
import type { FeatureKey } from "@studafy/constants";

/**
 * Units of a feature used per person per calendar month (UTC), in `app.feature_usage_meters`.
 *
 * Postgres is both the ledger and the decision: `consume` is one conditional upsert, so concurrent
 * requests serialize on the row lock and `used` can never pass the limit. The AI token budget keeps
 * its own Redis meter (modules/ai/usage/meter.ts) -- tokens are a cost guard counted after the model
 * answers, units are what a tier sells and are counted before the handler runs.
 */

export interface ConsumeInput {
  schoolId: string;
  userId: string;
  key: FeatureKey;
  amount: number;
  /** null is unlimited: the units are still counted. */
  limit: number | null;
  now?: Date;
  requestId?: string;
}

export type ConsumeResult =
  | { ok: true; used: number; periodStart: string }
  | { ok: false; used: number; periodStart: string };

export interface FeatureUsageMeter {
  consume(input: ConsumeInput): Promise<ConsumeResult>;
  /** Give back units a request consumed and then failed to use. Never goes below zero. */
  refund(input: {
    schoolId: string;
    userId: string;
    key: FeatureKey;
    amount: number;
    periodStart: string;
    requestId?: string;
  }): Promise<void>;
  /** Units used this month per feature, for one person. */
  read(schoolId: string, userId: string, now?: Date): Promise<Partial<Record<FeatureKey, number>>>;
}

export function createFeatureUsageMeter(deps: {
  database: Database | DatabasePools;
}): FeatureUsageMeter {
  const { database } = deps;

  return {
    async consume({ schoolId, userId, key, amount, limit, now = new Date(), requestId }) {
      const periodStart = usagePeriodStart(now);

      return withTenantTx(database, { schoolId, requestId }, async (tx) => {
        // Both arms carry the limit test: the INSERT arm for a first use bigger than the limit, the
        // UPDATE arm for every later one. A refused UPDATE returns no row and changes nothing.
        const [row] = await tx<{ used: string }[]>`
          INSERT INTO app.feature_usage_meters (school_id, user_id, feature_key, period_start, used)
          SELECT current_setting('app.school_id')::uuid, ${userId}::uuid, ${key}, ${periodStart}::date,
                 ${amount}
          WHERE ${limit}::bigint IS NULL OR ${amount} <= ${limit}::bigint
          ON CONFLICT ON CONSTRAINT pk_feature_usage_meters DO UPDATE
            SET used = app.feature_usage_meters.used + EXCLUDED.used,
                -- GREATEST: CURRENT_TIMESTAMP is this transaction's start, which can precede a row a
                -- concurrent transaction inserted first, and ck_..._timestamps forbids going back.
                updated_at = GREATEST(CURRENT_TIMESTAMP, app.feature_usage_meters.updated_at)
            WHERE ${limit}::bigint IS NULL
               OR app.feature_usage_meters.used + EXCLUDED.used <= ${limit}::bigint
          RETURNING used::text AS used
        `;
        if (row) return { ok: true, used: Number(row.used), periodStart };

        const [current] = await tx<{ used: string }[]>`
          SELECT used::text AS used
          FROM app.feature_usage_meters
          WHERE school_id = current_setting('app.school_id')::uuid
            AND user_id = ${userId}::uuid
            AND feature_key = ${key}
            AND period_start = ${periodStart}::date
        `;
        return { ok: false, used: Number(current?.used ?? 0), periodStart };
      });
    },

    async refund({ schoolId, userId, key, amount, periodStart, requestId }) {
      await withTenantTx(database, { schoolId, requestId }, async (tx) => {
        await tx`
          UPDATE app.feature_usage_meters
          SET used = GREATEST(used - ${amount}, 0),
              updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
          WHERE school_id = current_setting('app.school_id')::uuid
            AND user_id = ${userId}::uuid
            AND feature_key = ${key}
            AND period_start = ${periodStart}::date
        `;
      });
    },

    async read(schoolId, userId, now = new Date()) {
      const rows = await withTenantTx(
        database,
        { schoolId },
        (tx) => tx<{ feature_key: FeatureKey; used: string }[]>`
          SELECT feature_key, used::text AS used
          FROM app.feature_usage_meters
          WHERE school_id = current_setting('app.school_id')::uuid
            AND user_id = ${userId}::uuid
            AND period_start = ${usagePeriodStart(now)}::date
        `,
        { useReadReplica: true },
      );
      const usage: Partial<Record<FeatureKey, number>> = {};
      for (const row of rows) usage[row.feature_key] = Number(row.used);
      return usage;
    },
  };
}
