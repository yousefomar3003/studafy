/**
 * Address suppression lookups for the email channel.
 *
 * The suppression list is global (an address-level fact, registered in the ST-050 approved-global
 * allowlist) and is written by the SES SNS webhook in apps/api when a bounce or complaint arrives.
 * apps/workers never writes it — this module is read-only, and the write side lives where the
 * event lands.
 */

import type { TransactionSql } from "postgres";

/** True when the address must never be mailed again. */
export async function isSuppressed(tx: TransactionSql, address: string): Promise<boolean> {
  const [row] = await tx<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM app.email_suppressions WHERE address = ${address}
    ) AS exists
  `;
  return row?.exists ?? false;
}
