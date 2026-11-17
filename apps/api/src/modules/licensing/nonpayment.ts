import { instalmentsPastCutoff } from "./ai-stop";
import { readLicense, transitionLicense } from "./service";

import type { LicenseActor } from "./context";
import type { Changed } from "./service";
import type { TransactionSql } from "postgres";

/**
 * The API's half of "AI stops 30 days after an unpaid instalment" (migration 000233): the workers
 * suspend the licence; recording the payment that settles it resumes it at once, here.
 */

/**
 * Resume a licence stopped for non-payment once nothing on it is past the cutoff any more. A licence
 * the super admin suspended by hand, one past its end, or one whose school has since activated
 * another is left as it is.
 */
export async function resumeIfSettled(
  tx: TransactionSql,
  schoolId: string,
  licenseId: string,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<Omit<Changed<unknown>, "result"> & { resumed: boolean }> {
  const none = { resumed: false, versions: new Map<string, number>(), pending: [] };
  const [license] = await tx<{ status: string; nonpayment_suspended_at: Date | null }[]>`
    SELECT status, nonpayment_suspended_at FROM app.school_licenses
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${licenseId}::uuid
    FOR UPDATE
  `;
  if (!license || license.status !== "suspended" || !license.nonpayment_suspended_at) return none;
  const record = await readLicense(tx, licenseId);
  if (!record || record.endsAt.getTime() <= now.getTime()) return none;
  if ((await instalmentsPastCutoff(tx, licenseId, now)) > 0) return none;
  const [other] = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM app.school_licenses
    WHERE school_id = current_setting('app.school_id')::uuid AND status = 'active'
  `;
  if (other) return none;
  const changed = await transitionLicense(tx, schoolId, licenseId, "active", actor, now);
  return { resumed: true, versions: changed.versions, pending: changed.pending };
}
