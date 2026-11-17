/**
 * School enumeration for the sweeps (email dispatch and digests, retention, imports, closure, ...).
 *
 * Listing every school is a system operation: app.schools is row-level secured (QA-016), and a
 * tenant role sees only the school it is armed for -- with none armed, nothing. So this reads as
 * studafy_system, as the API's withSystemTx does, and returns ids only; each sweep then does its
 * per-school work in that school's own tenant transaction.
 */

import type { Sql } from "postgres";

export async function loadSchoolIds(db: Sql): Promise<string[]> {
  const rows = await db.begin(async (tx) => {
    await tx`SELECT set_config('role', 'studafy_system', true)`;
    return tx<{ id: string }[]>`SELECT id FROM app.schools ORDER BY id`;
  });
  return rows.map((row) => row.id);
}
