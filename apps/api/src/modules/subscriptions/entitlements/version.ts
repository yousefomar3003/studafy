import type { TransactionSql } from "postgres";

/**
 * Durable entitlement version counters (ST-133).
 *
 * The access token's `entitlements_ver` claim is a snapshot of the school's counter at mint time.
 * jwtAuthMiddleware rejects a token whose snapshot is below the current value, which is what turns a
 * Stripe cancellation into a sub-5-second loss of access rather than one bounded by the token's
 * 15-minute lifetime.
 *
 * Postgres is the source of truth, not Redis: a cache flush would otherwise reset every counter to
 * its genesis value and silently re-validate every stale token in the system. Redis still front-runs
 * this table on the read path — see ./cache.ts — but a miss re-reads it here.
 *
 * @see db/migrations/000080_create_entitlement_versions.sql
 */

/** The two subject kinds `app.entitlement_subject` allows. */
export type EntitlementSubject = "school" | "ai";

/**
 * The version of a subject that has no row yet.
 *
 * An absent row *is* version 1 — the first bump writes 2, which is what
 * `ck_entitlement_versions_version` asserts. This is deliberately the same value the pre-ST-133 code
 * hardcoded into every token (and that the test harness's `mintTestToken` still writes), so
 * outstanding tokens are already carrying the correct genesis value: no backfill, and the first real
 * bump correctly invalidates them.
 */
export const GENESIS_ENTITLEMENTS_VERSION = 1;

/**
 * Increment a subject's version and return the new value, creating the row on first use.
 *
 * Must run inside a transaction that has already armed `app.school_id` — `withTenantTx` does this at
 * BEGIN, and the billing webhook path gets it from `setTenantScope` once the school is attributed.
 * The GUC is read rather than passed so the row can never be written to a school other than the one
 * the surrounding transaction is scoped to, which is also what the RLS `WITH CHECK` enforces.
 *
 * ## Race safety under concurrent webhook redelivery
 *
 * `INSERT ... ON CONFLICT DO UPDATE` takes the row lock as part of the statement. When two
 * transactions target the same key the second blocks on the tuple lock, and once the first commits
 * PostgreSQL re-evaluates the conflict against the newly committed tuple and increments *that*
 * value. No lost update, and — the reason this shape rather than `SELECT ... FOR UPDATE` then
 * insert-or-update — no duplicate-key error under concurrency. This holds because the repo runs
 * `sql.begin()` without an isolation option, i.e. READ COMMITTED; under REPEATABLE READ the same
 * statement would raise a serialization failure instead.
 *
 * Exactness is not required and is not claimed: nothing anywhere compares against an expected
 * version. Only monotonicity matters, because every reader compares with `<`.
 */
export async function bumpEntitlementVersion(
  tx: TransactionSql,
  subject: EntitlementSubject,
  subjectId: string,
): Promise<number> {
  const [row] = await tx<{ version: string }[]>`
    INSERT INTO app.entitlement_versions (school_id, subject_type, subject_id, version)
    VALUES (
      current_setting('app.school_id')::uuid,
      ${subject}::app.entitlement_subject,
      ${subjectId}::uuid,
      ${GENESIS_ENTITLEMENTS_VERSION + 1}
    )
    ON CONFLICT ON CONSTRAINT pk_entitlement_versions
    DO UPDATE SET version = app.entitlement_versions.version + 1,
                  updated_at = CURRENT_TIMESTAMP
    RETURNING version::text AS version
  `;

  if (!row) {
    // Unreachable: ON CONFLICT DO UPDATE always returns the affected row. Treated as a failure
    // rather than defaulted, because a bump that silently returned the genesis version would emit an
    // event the consumer then refuses as stale, and the cache would never be invalidated.
    throw new Error(`entitlement version bump returned no row for ${subject}:${subjectId}`);
  }

  return Number(row.version);
}

/**
 * The current version for one subject, or {@link GENESIS_ENTITLEMENTS_VERSION} when no row exists.
 *
 * `version` is `bigint`, which postgres.js surfaces as a string to avoid the precision loss of
 * `Number` beyond 2^53. Cast at the boundary: a counter that would need 2^53 subscription changes
 * for one school is not a precision risk worth carrying a BigInt through the JWT claim for.
 */
export async function readEntitlementVersion(
  tx: TransactionSql,
  subject: EntitlementSubject,
  subjectId: string,
): Promise<number> {
  const [row] = await tx<{ version: string }[]>`
    SELECT version::text AS version
    FROM app.entitlement_versions
    WHERE school_id = current_setting('app.school_id')::uuid
      AND subject_type = ${subject}::app.entitlement_subject
      AND subject_id = ${subjectId}::uuid
  `;

  return row ? Number(row.version) : GENESIS_ENTITLEMENTS_VERSION;
}
