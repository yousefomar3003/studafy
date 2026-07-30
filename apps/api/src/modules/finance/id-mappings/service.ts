/**
 * The Studafy <-> ERPNext identity crosswalk (ST-119).
 *
 * `app.erpnext_id_mappings` has existed since migration 000015 and, until now, nothing read or
 * wrote it. This is that missing layer.
 *
 * The table answers one question in both directions: given a Studafy UUID, what is this document
 * called in ERPNext, and vice versa. It matters because the two systems name things
 * incompatibly — ERPNext identifies documents by human-readable `name` strings assigned by a
 * naming series (`FS-2026-0001`), while everything here is a UUID. Without a durable crosswalk the
 * only way back from an ERPNext webhook to a local row is string matching on a title, which breaks
 * the first time somebody renames a fee structure.
 *
 * Both unique constraints already exist on the table and are load-bearing here:
 *
 *   - `uq_erpnext_id_mappings_school_entity_studafy_id` — one ERPNext document per local entity
 *   - `uq_erpnext_id_mappings_school_entity_docname`   — one local entity per ERPNext document
 *
 * Together they make the mapping a bijection within a school, which is what lets `upsertMapping`
 * be safely idempotent: re-syncing the same document is a no-op rather than a duplicate row.
 */

import type { TransactionSql } from "postgres";

/** Mirrors the `app.finance_entity_type` enum; 'fee_structure'/'fee_category' added in 000060. */
export type FinanceEntityType =
  "invoice" | "payment" | "fee_schedule" | "fee_structure" | "fee_category" | "expense";

export interface ErpNextIdMapping {
  id: string;
  school_id: string;
  entity: FinanceEntityType;
  studafy_id: string;
  erpnext_docname: string | null;
}

const MAPPING_COLUMNS = `
  id, school_id, entity::text AS entity, studafy_id, erpnext_docname
`;

function parseMappingRow(row: Record<string, unknown>): ErpNextIdMapping {
  return {
    id: row.id as string,
    school_id: row.school_id as string,
    entity: row.entity as FinanceEntityType,
    studafy_id: row.studafy_id as string,
    erpnext_docname: row.erpnext_docname as string | null,
  };
}

/**
 * Record (or refresh) the crosswalk for one document.
 *
 * Idempotent on `(school_id, entity, studafy_id)`. The `WHERE` on the update clause suppresses a
 * write when nothing changed, so a re-sync of an unchanged document does not churn `updated_at`
 * and does not take a row lock other callers would queue behind.
 */
export async function upsertMapping(
  tx: TransactionSql,
  schoolId: string,
  entity: FinanceEntityType,
  studafyId: string,
  erpnextDocname: string,
): Promise<ErpNextIdMapping> {
  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.erpnext_id_mappings (school_id, entity, studafy_id, erpnext_docname)
    VALUES (
      ${schoolId}::uuid,
      ${entity}::app.finance_entity_type,
      ${studafyId}::uuid,
      ${erpnextDocname}
    )
    ON CONFLICT (school_id, entity, studafy_id) DO UPDATE
      SET erpnext_docname = EXCLUDED.erpnext_docname,
          updated_at = CURRENT_TIMESTAMP
      WHERE app.erpnext_id_mappings.erpnext_docname IS DISTINCT FROM EXCLUDED.erpnext_docname
    RETURNING ${tx.unsafe(MAPPING_COLUMNS)}
  `;

  // A suppressed no-op update returns no row. The mapping is already correct, so read it back
  // rather than reporting a failure that did not happen.
  if (!row) {
    const existing = await findByStudafyId(tx, schoolId, entity, studafyId);
    if (!existing) {
      throw new Error(`ERPNext id mapping vanished during upsert: ${entity}/${studafyId}`);
    }
    return existing;
  }

  return parseMappingRow(row);
}

export async function findByStudafyId(
  tx: TransactionSql,
  schoolId: string,
  entity: FinanceEntityType,
  studafyId: string,
): Promise<ErpNextIdMapping | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(MAPPING_COLUMNS)}
    FROM app.erpnext_id_mappings
    WHERE school_id = ${schoolId}::uuid
      AND entity = ${entity}::app.finance_entity_type
      AND studafy_id = ${studafyId}::uuid
  `;
  return row ? parseMappingRow(row) : undefined;
}

export async function findByDocname(
  tx: TransactionSql,
  schoolId: string,
  entity: FinanceEntityType,
  erpnextDocname: string,
): Promise<ErpNextIdMapping | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(MAPPING_COLUMNS)}
    FROM app.erpnext_id_mappings
    WHERE school_id = ${schoolId}::uuid
      AND entity = ${entity}::app.finance_entity_type
      AND erpnext_docname = ${erpnextDocname}
  `;
  return row ? parseMappingRow(row) : undefined;
}
