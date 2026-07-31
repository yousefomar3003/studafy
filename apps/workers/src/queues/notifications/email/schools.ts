/**
 * School enumeration for the email channel.
 *
 * Both the dispatcher and the digest producer walk the school list to scope their work per
 * tenant. app.schools is a global table with no RLS, so the plain connection can read it.
 */

import type { Sql } from "postgres";

export async function loadSchoolIds(db: Sql): Promise<string[]> {
  const rows = await db<{ id: string }[]>`
    SELECT id FROM app.schools ORDER BY id
  `;
  return rows.map((row) => row.id);
}
