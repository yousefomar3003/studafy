/**
 * The erasure half of the GDPR pipeline (ST-268).
 *
 * One function drives both shapes of erasure request app.data_subject_requests can hold:
 * `subject === undefined` erases everything found for a whole school (tenant closure); a resolved
 * `subject` narrows every table to the rows that identify that one person (a filed DSR). Same
 * classification (retention-registry.ts), same redaction primitive (redact.ts) either way -- scope
 * is the only thing that differs, which is exactly why runTenantErasure takes it as a parameter
 * instead of being two separate functions.
 */

import { armAdminActor, resolveAdminActor } from "./admin-actor";
import { hardDeleteRows, redactPersonalColumns } from "./redact";
import { classifyTable } from "./retention-registry";
import { findSubjectPredicate } from "./subject-resolver";
import { discoverTenantTables } from "./tenant-tables";

import type { RedactedTableEntry, RetainedTableEntry } from "./dsr-types";
import type { SubjectIdentifiers } from "./subject-resolver";
import type { TransactionSql } from "postgres";

export interface ErasureResult {
  redactedTables: RedactedTableEntry[];
  retainedTables: RetainedTableEntry[];
}

/**
 * Runs inside a transaction that already has `app.school_id` armed (`withSystemTenantTx`) --
 * `armAdminActor` additionally sets `app.user_id` here because the walk below reaches
 * role-scope-gated tables a bare system transaction never touches. See admin-actor.ts's header.
 */
export async function runTenantErasure(
  tx: TransactionSql,
  schoolId: string,
  subject?: SubjectIdentifiers,
): Promise<ErasureResult> {
  const adminUserId = await resolveAdminActor(tx, schoolId);
  await armAdminActor(tx, adminUserId);

  const tables = await discoverTenantTables(tx);
  const redacted: RedactedTableEntry[] = [];
  const retained: RetainedTableEntry[] = [];

  for (const { tableName } of tables) {
    // This pipeline's own compliance trail must not be touched by the erasure it is recording.
    if (tableName === "data_subject_requests") continue;

    const action = classifyTable(tableName);
    if (action === "legal_hold") {
      retained.push({ table: tableName, reason: "financial/audit legal hold" });
      continue;
    }

    const predicate = subject ? await findSubjectPredicate(tx, tableName, subject) : undefined;
    // A per-user request scoped to a table with no subject-link column has nothing to act on --
    // not an error, just out of this pipeline's documented reach (retention-registry.ts's
    // SUBJECT_LINK_COLUMNS doc comment).
    if (subject && !predicate) continue;

    if (action === "hard_delete") {
      const rows = await hardDeleteRows(tx, tableName, schoolId, predicate ?? undefined);
      if (rows > 0) redacted.push({ table: tableName, action: "hard_deleted", columns: [], rows });
      continue;
    }

    const outcome = await redactPersonalColumns(tx, tableName, schoolId, predicate ?? undefined);
    if (outcome.columns.length > 0 && outcome.rowsAffected > 0) {
      redacted.push({
        table: tableName,
        action: "redacted",
        columns: outcome.columns,
        rows: outcome.rowsAffected,
      });
    }
  }

  // A tenant-wide closure additionally owns the school's own contact identity: app.schools is
  // global (no school_id column), so it is never discovered by tenant-tables.ts and the loop above
  // never reaches it. redactPersonalColumns' "school_id = $1" WHERE assumption does not apply to
  // this table either -- it IS the tenant, scoped by its own id.
  if (!subject) {
    const result = await tx`
      UPDATE app.schools
      SET email = 'erased-' || gen_random_uuid()::text || '@erased.invalid',
          normalized_email = 'erased-' || gen_random_uuid()::text || '@erased.invalid'
      WHERE id = ${schoolId}::uuid
    `;
    if (result.count > 0) {
      redacted.push({
        table: "schools",
        action: "redacted",
        columns: ["email", "normalized_email"],
        rows: result.count,
      });
    }
  }

  return { redactedTables: redacted, retainedTables: retained };
}
