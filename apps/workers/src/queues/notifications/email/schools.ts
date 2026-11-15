/**
 * School enumeration for the email channel.
 *
 * Both the dispatcher and the digest producer walk the school list to scope their work per
 * tenant. app.schools is a global table with no RLS; it is still read as studafy_app (QA-014): the
 * plain connection runs as the database login, which a least-privilege login cannot serve.
 */

import type { Sql } from "postgres";

export async function loadSchoolIds(db: Sql): Promise<string[]> {
  const rows = await db.begin(async (tx) => {
    await tx`SELECT set_config('role', 'studafy_app', true)`;
    return tx<{ id: string }[]>`SELECT id FROM app.schools ORDER BY id`;
  });
  return rows.map((row) => row.id);
}
