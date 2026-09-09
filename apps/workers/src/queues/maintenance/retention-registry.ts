/**
 * The retention/erasure classification registry (ST-268): the one place that decides what an
 * erasure pass is and is not allowed to do to a table, and which of its columns count as personal
 * data worth touching.
 *
 * Three sets, deliberately small and explicit rather than inferred, because "does this table get
 * erased" is a legal decision, not a heuristic one:
 *
 *   LEGAL_HOLD_TABLES  -- financial, audit and security records. Erasure never touches these at
 *                         all (no delete, no redaction) -- GDPR Art. 17(3)(b) exempts data a
 *                         controller must keep for compliance with a legal obligation, and a school's
 *                         financial ledger and its audit trail are exactly that. A row here is
 *                         recorded in `retained_tables` on the request, not silently skipped.
 *   HARD_DELETE_TABLES -- pure security/session artifacts: revoking access is the entire point of
 *                         the row, there is no non-personal remainder worth keeping, and nothing
 *                         else in the schema references one by foreign key (see db/migrations 000029,
 *                         000030, 000034 for the underlying tables).
 *   everything else discovered as a tenant table (see tenant-tables.ts) is REDACTED, never deleted.
 *
 * Redaction, not deletion, is the default because this schema has no cascading deletes worth relying
 * on -- every tenant foreign key in this codebase is declared `ON DELETE RESTRICT`
 * (docs/database/migration-policy.md), the same fact infra/tools/tenant-restore's README documents
 * at length for the sibling ST-267 tool. Deleting an arbitrary tenant table's rows in the right
 * cross-table order is exactly the FK-ordering problem that tool had to solve with a topological
 * sort; redacting a row's personal-looking columns in place needs no such ordering, because the row
 * (and the id every other table's foreign key points at) never goes away.
 */

/**
 * Financial, audit and security tables (ST-268's "financial/audit" legal hold). Grouped by why they
 * are here, not alphabetically, so a reviewer can see the boundary is "compliance record", not
 * "everything that looked sensitive".
 */
export const LEGAL_HOLD_TABLES: ReadonlySet<string> = new Set([
  // Audit trail (docs/database/audit-logs-data-model.md). The entire point of an audit log is that
  // past entries are immutable and attributable; redacting the actor would defeat it.
  "audit_logs",
  "audit_export_jobs",
  // Billing/subscription ledger -- a closed school's subscription and entitlement history remains
  // legally discoverable for accounting purposes.
  "subscriptions",
  "ai_subscriptions",
  "entitlement_versions",
  // ERPNext-synced finance records and their caches (docs/database/finance-data-model.md).
  "invoice_batches",
  "invoice_batch_items",
  "invoice_batch_target_classes",
  "invoice_cache",
  "payment_cache",
  "expense_cache",
  "fee_schedule_cache",
  "fee_structure_cache",
  "installment_cache",
  "scholarship_discount_cache",
  "award_cache",
  "finance_reconciliation_logs",
  "refund_requests",
  "joinvoice_export_logs",
  "erpnext_id_mappings",
  // This pipeline's own compliance record: an erasure request row is the proof the erasure ran.
  // Erasing it would erase the evidence that GDPR was complied with.
  "data_subject_requests",
]);

/**
 * Pure session/security artifacts. A row here IS the personal-access grant; once revoked there is
 * nothing else in it worth retaining, and no other tenant table holds a foreign key into one (each
 * is a leaf in the FK graph discover-tenant-tables.sql would place at level 0).
 */
export const HARD_DELETE_TABLES: ReadonlySet<string> = new Set([
  "refresh_tokens",
  "user_devices",
  "oauth_identities",
]);

/**
 * Global (non-tenant) tables that hold financial/audit/security data but never appear in
 * discoverTenantTables' output, because they have no `school_id` column at all --
 * `app.billing_events` records a provider event before it can even be attributed to a school
 * (packages/billing/src/attribution.ts), and `app.security_events` records a rejection raised before
 * authentication established any tenant (db/migrations/000028). Ground truth for this list is
 * `approved_globals` in db/policies/rls-coverage.ts, not a set this module tracks separately.
 *
 * They are listed here only so a reader of LEGAL_HOLD_TABLES does not wonder why two obviously
 * financial/security tables are missing from it: they are out of reach of a per-school pipeline by
 * construction, not by an oversight in this registry. Neither tenant-closure export nor tenant/user
 * erasure touches them.
 */
export const OUT_OF_SCOPE_GLOBAL_TABLES: ReadonlySet<string> = new Set([
  "billing_events",
  "security_events",
]);

export type ErasureAction = "legal_hold" | "hard_delete" | "redact";

export function classifyTable(tableName: string): ErasureAction {
  if (LEGAL_HOLD_TABLES.has(tableName)) return "legal_hold";
  if (HARD_DELETE_TABLES.has(tableName)) return "hard_delete";
  return "redact";
}

/**
 * Column-name patterns treated as personal data wherever they appear on a table subject to
 * redaction. Matched against the bare column name (`information_schema.columns.column_name`),
 * case-insensitively, anchored so `class_name` or `subject_name` (structural, not personal) do not
 * false-positive alongside `display_name`/`first_name`.
 *
 * This is a column-name allowlist, not a data-scan: it cannot find personal data hiding in a
 * differently-named or free-form column (see the module doc's "Known gaps" in
 * docs/database/data-retention-and-dsr.md). It is deliberately conservative for the same reason
 * PII_COLUMN_PATTERNS.test.ts pins each entry to a real, verified column -- a pattern that is too
 * broad silently destroys data an erasure request was never asked to touch, which is a worse failure
 * than a pattern that is too narrow and leaves a documented gap.
 */
export const PII_COLUMN_PATTERNS: readonly RegExp[] = [
  /^(first|middle|last|preferred|full|legal|display|guardian|contact|emergency)_name$/i,
  /^name$/i,
  /^original_file_name$/i,
  /^(normalized_)?email$/i,
  /_email$/i,
  /^phone(_number)?$/i,
  /_phone(_number)?$/i,
  /^date_of_birth$/i,
  /^address$/i,
  /_address$/i,
  /^notes?$/i,
  /^comments?$/i,
  /^bio$/i,
  /^national_id$/i,
  /^passport_number$/i,
];

export function isPersonalDataColumn(columnName: string): boolean {
  return PII_COLUMN_PATTERNS.some((pattern) => pattern.test(columnName));
}

/**
 * Column names this schema uses consistently to link a row to the person it is about. Deliberately
 * a short, verified list (app.students.user_id / app.teachers.user_id: db/migrations/000008; the
 * many `student_id`/`teacher_id` foreign keys across assignments, grades, attendance and evaluation
 * tables) rather than every spelling a "who does this belong to" column might take across 100+
 * tables (`created_by`, `invited_by`, `actor_id`, `uploaded_by`, ...) -- see the retention policy
 * doc's "Known gaps" for what a per-user request does not reach as a result.
 */
export const SUBJECT_LINK_COLUMNS: readonly string[] = ["user_id", "student_id", "teacher_id"];
