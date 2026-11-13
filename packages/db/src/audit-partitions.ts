// Administrative partition maintenance for the monthly-partitioned audit log (ST-046).
//
// Creates every missing monthly partition from the current UTC month through months-ahead months later,
// giving each new partition its owner, append-only grants (SELECT and INSERT, never UPDATE or DELETE),
// forced RLS, canonical tenant policy, and the parent's indexes. It never drops, detaches, or alters an
// existing partition: retention is out of scope and deliberately not automated. See
// docs/database/audit-log-partition-maintenance.md.
//
// The operational envelope is shared with attendance via ./partitions; the SQL helper it calls
// (app.ensure_audit_log_partitions, 000018) is audit-specific precisely because the grants are.
//
// This is not runtime code. It connects with the administrative/migration identity and runs as
// studafy_admin; studafy_app has no EXECUTE on the underlying helpers and cannot run it.
import { AUDIT_LOG_PARTITIONS, ensureMonthlyPartitions } from "./partitions";

import type { PartitionCommandOptions } from "./partitions";

export { PARTITION_ADVISORY_LOCK_KEY, parseMonthsAhead } from "./partitions";
export type { PartitionCommandOptions } from "./partitions";

export async function ensureAuditLogPartitions(
  monthsAhead: number,
  options: PartitionCommandOptions = {},
): Promise<string[]> {
  return ensureMonthlyPartitions(AUDIT_LOG_PARTITIONS, monthsAhead, options);
}
