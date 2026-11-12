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
  "storage_subscriptions",
  "entitlement_versions",
  // Tap renewal charges, online fee payments and the payer's provider customer (ST-298): each is
  // the local half of a money movement at a payment provider.
  "tap_renewal_attempts",
  "online_fee_payments",
  "payment_provider_customers",
  // Subscription refund requests (db/migrations/000129): the school-side record of a refund of a
  // subscription charge.
  "subscription_refund_requests",
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

/**
 * Free text and files a person wrote themselves, which column-name redaction cannot reach: the body
 * of a message is not a "name" column, and an Ask AI turn is keyed by `conversation_id`, not by a
 * SUBJECT_LINK_COLUMNS column. authored-content-dsr.ts erases these for a person (by who wrote or
 * owns them) or for a whole school, before the generic walk runs; the walk then still redacts any
 * personal-looking column on whatever that pass deliberately kept.
 *
 *   replace_text -- the row stays, its text becomes AUTHORED_TEXT_ERASED_MARKER. Used where other
 *                   people's data hangs off the row: a message is one turn in someone else's
 *                   conversation, so the thread keeps its shape and the other side's messages stay
 *                   coherent. app.notifications is here only for its DIRECT_MESSAGE rows, whose body
 *                   quotes the sender's message to the recipient.
 *   delete       -- the row goes. Used where nothing outside the person's own content depends on it:
 *                   a message's images, and everything the AI study assistant stored for a student
 *                   (questions, answers, citations, quizzes, flashcards and reviews, practice exams).
 *
 * Deliberately NOT here, so they stay the school's record (docs/modules/account-deletion.md):
 * work handed in to a teacher (assignment_submissions, submission_attachments), marks, attendance,
 * discipline, everything in LEGAL_HOLD_TABLES, and safeguarding reports -- app.message_reports with
 * its evidence snapshot (message_report_messages / _attachments) and app.ai_content_reports, which
 * carries its own copy of the reported text. A message an open report points at is kept too
 * (authored-content-dsr.ts), and so is an image a report's snapshot points at.
 *
 * Summaries and concept maps are not stored in PostgreSQL: they live in a Redis cache for 24 hours
 * (AI_SUMMARY_CACHE_TTL_SECONDS), well inside the 14-day deletion grace period. Ask AI has no
 * uploads: a photographed page is read on the server and never stored.
 */
export type AuthoredContentAction = "replace_text" | "delete";

export const AUTHORED_CONTENT_TABLES: ReadonlyMap<string, AuthoredContentAction> = new Map<
  string,
  AuthoredContentAction
>([
  // Parent <-> teacher messaging (000127, 000134).
  ["messages", "replace_text"],
  ["message_attachments", "delete"],
  ["notifications", "replace_text"],
  // The AI study assistant (000021, 000099, 000101, 000102).
  ["ai_conversations", "delete"],
  ["ai_messages", "delete"],
  ["ai_message_citations", "delete"],
  ["quizzes", "delete"],
  ["quiz_questions", "delete"],
  ["quiz_question_options", "delete"],
  ["flashcard_decks", "delete"],
  ["flashcards", "delete"],
  ["flashcard_reviews", "delete"],
  ["exam_sessions", "delete"],
  ["exam_items", "delete"],
  ["exam_item_options", "delete"],
  ["exam_item_answers", "delete"],
]);

/** What a person's erased message (and its notification preview) reads as afterwards. */
export const AUTHORED_TEXT_ERASED_MARKER = "[deleted]";

export type ErasureAction = "legal_hold" | "hard_delete" | "redact";

export function classifyTable(tableName: string): ErasureAction {
  if (LEGAL_HOLD_TABLES.has(tableName)) return "legal_hold";
  if (HARD_DELETE_TABLES.has(tableName)) return "hard_delete";
  return "redact";
}

/** How authored-content-dsr.ts erases a table's rows, or null if that pass does not touch it. */
export function authoredContentAction(tableName: string): AuthoredContentAction | null {
  if (LEGAL_HOLD_TABLES.has(tableName)) return null;
  return AUTHORED_CONTENT_TABLES.get(tableName) ?? null;
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
 *
 * `staff_user_id` (app.record_answers, 000181) is the member of staff a staff record is about: the
 * person's own user id under the name that says which subject column it is. It is listed so no
 * table holding it is out of a per-person request's reach by naming alone; record_answers itself
 * is RECORD_DATA_TABLES' (records-dsr.ts), which exports it opened and erases it outright.
 *
 * app.custom_list_rows (000182) reaches a person through `student_id` (a student) and `user_id` (a
 * parent or a member of staff), both already listed; its `class_id` is a class, not a person, and is
 * deliberately not a link column. Its cells (app.custom_list_values) have no link column at all.
 * Both tables are RECORD_DATA_TABLES' too: records-dsr.ts exports a person's linked rows with their
 * cells opened and deletes them outright, and a tenant closure deletes every list. Neither is a
 * legal hold -- a school's own working list is not a compliance record.
 */
export const SUBJECT_LINK_COLUMNS: readonly string[] = [
  "user_id",
  "student_id",
  "teacher_id",
  "staff_user_id",
];
