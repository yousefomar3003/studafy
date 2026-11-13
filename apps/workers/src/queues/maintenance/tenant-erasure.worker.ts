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
import { eraseAuthoredContent } from "./authored-content-dsr";
import { eraseImportData } from "./imports-dsr";
import { RECORD_DATA_TABLES, eraseCustomListData, eraseRecordData } from "./records-dsr";
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
  /**
   * Record documents, import source files and message images this erasure released: remove them
   * after commit.
   */
  orphanedStorageKeys: string[];
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

  // What the person wrote themselves (retention-registry.ts AUTHORED_CONTENT_TABLES): message
  // bodies and images, and their AI study content. First, so the walk below only sees what this pass
  // deliberately kept (safeguarding evidence) and redacts its personal-looking columns as before.
  const authored = await eraseAuthoredContent(tx, schoolId, subject);

  const tables = await discoverTenantTables(tx);
  const redacted: RedactedTableEntry[] = [...authored.redacted];
  const retained: RetainedTableEntry[] = [...authored.retained];

  for (const { tableName } of tables) {
    // This pipeline's own compliance trail must not be touched by the erasure it is recording.
    if (tableName === "data_subject_requests") continue;
    // Record answers and custom list rows and cells are deleted outright, below (records-dsr.ts).
    if (RECORD_DATA_TABLES.has(tableName)) continue;

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

  // School-defined records hold nothing worth keeping once their subject is erased: no redacted
  // remainder, so the answers go entirely (their documents cascade).
  const records = await eraseRecordData(tx, schoolId, subject);
  if (records.rows > 0) {
    redacted.push({
      table: "record_answers",
      action: "hard_deleted",
      columns: [],
      rows: records.rows,
    });
  }

  // Custom lists (records-dsr.ts): a person's linked rows go entirely, cells and all; a closure
  // deletes every list with its columns, choices, rows and cells.
  const customLists = await eraseCustomListData(tx, schoolId, subject);
  if (customLists.rows > 0) {
    redacted.push({
      table: "custom_list_rows",
      action: "hard_deleted",
      columns: [],
      rows: customLists.rows,
    });
  }
  if (customLists.lists > 0) {
    redacted.push({
      table: "custom_lists",
      action: "hard_deleted",
      columns: [],
      rows: customLists.lists,
    });
  }

  // Student import files and leftover cells (imports-dsr.ts): a closure deletes them all; a person's
  // request deletes their leftover cells and records the files, which cannot be redacted, as
  // retained until their retention period ends.
  const imports = await eraseImportData(tx, schoolId, subject);
  if (imports.rows > 0) {
    redacted.push({
      table: "student_import_rows",
      action: "hard_deleted",
      columns: [],
      rows: imports.rows,
    });
  }
  if (imports.storageKeys.length > 0) {
    redacted.push({
      table: "student_imports",
      action: "redacted",
      columns: ["source_storage_key", "source_size_bytes"],
      rows: imports.storageKeys.length,
    });
  }
  retained.push(...imports.retained);

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

  return {
    redactedTables: redacted,
    retainedTables: retained,
    orphanedStorageKeys: [...records.storageKeys, ...imports.storageKeys, ...authored.storageKeys],
  };
}
