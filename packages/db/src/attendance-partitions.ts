// Administrative partition maintenance for the monthly-partitioned attendance tables (ST-040).
//
// Creates every missing monthly partition from the current UTC month through months-ahead months later,
// giving each new partition its owner, grants, forced RLS, canonical tenant policy, and the parent's
// indexes. It never drops, detaches, or alters an existing partition: retention is out of scope and
// deliberately not automated. See docs/database/attendance-partition-maintenance.md.
//
// The operational envelope (connection, shared advisory lock, transaction, logging, credential redaction)
// lives in ./partitions and is shared with the audit log family added by ST-046. Attendance's SQL helpers
// remain its own: app.ensure_attendance_partitions grants a new partition full CRUD, which is correct for
// attendance and would be a defect for an append-only audit log.
//
// This is not runtime code. It connects with the administrative/migration identity and runs as
// studafy_admin; studafy_app has no EXECUTE on the underlying helpers and cannot run it.
import { ATTENDANCE_PARTITIONS, ensureMonthlyPartitions } from "./partitions";

import type { PartitionCommandOptions } from "./partitions";

export { PARTITION_ADVISORY_LOCK_KEY, parseMonthsAhead } from "./partitions";
export type { PartitionCommandOptions } from "./partitions";

export async function ensureAttendancePartitions(
  monthsAhead: number,
  options: PartitionCommandOptions = {},
): Promise<string[]> {
  return ensureMonthlyPartitions(ATTENDANCE_PARTITIONS, monthsAhead, options);
}
