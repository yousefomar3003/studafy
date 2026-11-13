/**
 * Append-only `app.audit_logs` writes for the workers process.
 *
 * A port of `emitAuditLog` in apps/api/src/middleware/auditEmitter.ts rather than an import, for the
 * same reason db/tenant-tx.ts is a port of its API counterpart: apps/workers has no dependency edge
 * to apps/api. The column list and the GUC-derived identity columns must stay in step with that
 * file; if one gains a column, so does the other.
 *
 * Deliberately narrower than the original. It carries no redaction pass: its callers are billing
 * state transitions (ST-132), which write `{ status }` on both sides, and the student import
 * migration (ST-299), which writes student, parent and link columns. None of those can hold a
 * secret. A caller that needs to audit richer values should bring `redactPayload` across with it.
 *
 * Identity comes from the session GUCs set by the enclosing tenant transaction, not from arguments:
 * `app.school_id` is required, `app.user_id` is NULL for unattended work, and a NULL `actor_id` is
 * the accurate record that no person did this.
 *
 * Throws on failure, which rolls the calling transaction back and takes the audited change with it.
 * That coupling is the point.
 */

import type { JSONValue, TransactionSql } from "postgres";

export interface WorkerAuditEntry {
  action: "insert" | "update" | "delete";
  targetTable: string;
  targetId: string;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
}

/** Rows per INSERT in `emitAuditLogs`: one statement per chunk rather than one per entry. */
const AUDIT_BATCH_SIZE = 1_000;

export async function emitAuditLog(tx: TransactionSql, entry: WorkerAuditEntry): Promise<void> {
  await emitAuditLogs(tx, [entry]);
}

/** Write many audit rows in the calling transaction, in chunks. */
export async function emitAuditLogs(
  tx: TransactionSql,
  entries: readonly WorkerAuditEntry[],
): Promise<void> {
  for (let i = 0; i < entries.length; i += AUDIT_BATCH_SIZE) {
    const rows = entries.slice(i, i + AUDIT_BATCH_SIZE).map((entry) => ({
      action: entry.action,
      target_table: entry.targetTable,
      target_id: entry.targetId,
      old_values: entry.oldValues,
      new_values: entry.newValues,
    }));

    // tx.json(), not JSON.stringify(): postgres.js serializes parameters bound to a jsonb value, so
    // a pre-stringified value is encoded twice and arrives as a JSON *string*. jsonb_to_recordset
    // reads a JSON null as SQL NULL, which keeps "no old values" distinct from a JSON null.
    await tx`
      INSERT INTO app.audit_logs (
        school_id,
        actor_id,
        action,
        target_table,
        target_id,
        old_values,
        new_values,
        request_id
      )
      SELECT
        current_setting('app.school_id', true)::uuid,
        NULLIF(current_setting('app.user_id', true), '')::uuid,
        entry.action::app.audit_action,
        entry.target_table,
        entry.target_id,
        entry.old_values,
        entry.new_values,
        NULLIF(current_setting('app.request_id', true), '')::uuid
      FROM jsonb_to_recordset(${tx.json(rows as unknown as JSONValue)}::jsonb) AS entry (
        action text,
        target_table text,
        target_id uuid,
        old_values jsonb,
        new_values jsonb
      )
    `;
  }
}
