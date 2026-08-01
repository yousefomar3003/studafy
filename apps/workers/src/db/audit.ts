/**
 * Append-only `app.audit_logs` writes for the workers process.
 *
 * A port of `emitAuditLog` in apps/api/src/middleware/auditEmitter.ts rather than an import, for the
 * same reason db/tenant-tx.ts is a port of its API counterpart: apps/workers has no dependency edge
 * to apps/api. The column list and the GUC-derived identity columns must stay in step with that
 * file; if one gains a column, so does the other.
 *
 * Deliberately narrower than the original. It carries no redaction pass, because the one caller
 * (billing state transitions, ST-132) writes `{ status }` on both sides and nothing that could
 * contain a secret. A caller that needs to audit richer values belongs in apps/api, or should bring
 * `redactPayload` across with it.
 *
 * Identity comes from the session GUCs set by the enclosing tenant transaction, not from arguments:
 * `app.school_id` is required, `app.user_id` is NULL for unattended work, and a NULL `actor_id` is
 * the accurate record that no person did this.
 *
 * Throws on failure, which rolls the calling transaction back and takes the audited change with it.
 * That coupling is the point.
 */

import type { BillingAuditEntry } from "@studafy/billing";
import type { JSONValue, TransactionSql } from "postgres";

export async function emitAuditLog(tx: TransactionSql, entry: BillingAuditEntry): Promise<void> {
  // tx.json(), not JSON.stringify(): postgres.js serializes parameters bound to a jsonb column, so a
  // pre-stringified value is encoded twice and stored as a JSON *string*, which the audit table's
  // object-only constraints correctly reject.
  const oldJson = tx.json(entry.oldValues as unknown as JSONValue);
  const newJson = tx.json(entry.newValues as unknown as JSONValue);

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
    ) VALUES (
      current_setting('app.school_id', true)::uuid,
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      ${entry.action}::app.audit_action,
      ${entry.targetTable},
      ${entry.targetId}::uuid,
      ${oldJson}::jsonb,
      ${newJson}::jsonb,
      NULLIF(current_setting('app.request_id', true), '')::uuid
    )
  `;
}
