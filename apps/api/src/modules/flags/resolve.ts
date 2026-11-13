import type { TransactionSql } from "postgres";

/**
 * Per-tenant flag override resolution from the database.
 *
 * The one query this module ever runs: does this school carry a row for this flag? RLS scopes it
 * to the caller's own tenant transaction, so the answer is provably about the request's school —
 * the same `current_setting('app.school_id')` lookup every other tenant resolver in the codebase
 * (cf. entitlements/resolve.ts) relies on.
 *
 * `null` means "no override": the deployment default applies. A boolean means the school's row
 * wins, either direction — see docs/database/feature-flags-data-model.md for the precedence.
 */
export async function resolveFlagOverride(
  tx: TransactionSql,
  flagName: string,
): Promise<boolean | null> {
  const [row] = await tx<{ enabled: boolean }[]>`
    SELECT enabled
    FROM app.feature_flags
    WHERE school_id = current_setting('app.school_id')::uuid
      AND flag_name = ${flagName}
  `;
  return row?.enabled ?? null;
}
