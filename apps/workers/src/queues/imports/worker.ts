/**
 * Staging-to-target migration for confirmed student imports (ST-097, ST-299).
 *
 * The API stages every CSV line in app.student_import_rows, mapped and validated. This job moves the
 * valid ones into app.users / app.students / app.parent_child_links, and template columns into
 * app.record_answers (sensitive ones sealed, ADR-019). Once the import has completed its staged
 * rows -- the uploaded file's cells -- are deleted in the same transaction.
 *
 * Parents are never matched by email (docs/modules/finance-module-guide.md): a row whose
 * parent_email belongs to an existing account imports its student unlinked (PARENT_ACCOUNT_EXISTS),
 * and rows sharing one new parent_email share the one parent the first of them creates.
 *
 * Atomic: the whole import is one transaction. The plan, every write, every audit row and the
 * `completed` status commit together or not at all, so a failure part-way leaves no half-imported
 * school behind. The import is marked `failed` in a separate transaction afterwards.
 *
 * Idempotent on retry: nothing is written outside that transaction, and the plan is recomputed from
 * live data each attempt (never from an earlier dry run). A retry after a failure therefore starts
 * clean; a retry after success sees `completed` under the row lock and returns the stored summary.
 *
 * Runs as a system tenant transaction (studafy_admin, tenant isolation still armed). It must: the
 * restrictive role_scope_visibility policy on app.students is granted to studafy_app and resolves
 * the acting user, so an unattended studafy_app transaction can neither see students nor INSERT ...
 * RETURNING one. `app.user_id` is still set to whoever confirmed the import, so each audit row names
 * the admin who asked for the change.
 */

import { normalizeRecordValue, sealRecordValue } from "@studafy/records";
import { normalizeEmail, planStudentImport } from "@studafy/student-import";
import postgres from "postgres";

import { emitAuditLogs } from "../../db/audit";
import { withSystemTenantTx } from "../../db/tenant-tx";

import type { WorkerAuditEntry } from "../../db/audit";
import type {
  RecordFieldOption,
  RecordFieldSensitivity,
  RecordFieldType,
  RecordKeyring,
  RecordValue,
} from "@studafy/records";
import type {
  PlannedRow,
  StagedRecord,
  StudentImportPlan,
  StudentImportRecord,
} from "@studafy/student-import";
import type { Sql, TransactionSql } from "postgres";

export interface StudentImportJobData {
  importId: string;
  schoolId: string;
}

export interface StudentImportSummary {
  students_created: number;
  students_updated: number;
  /** Rows not written: already up to date, or in conflict. */
  students_skipped: number;
  conflicts: number;
  parents_created: number;
  /** Parent-student links created. */
  parents_linked: number;
  /** Rows whose parent_email already belonged to an account: student imported, parent unlinked. */
  parent_conflicts: number;
  /** Student record answers written from template columns. */
  record_answers: number;
}

/** Statuses a migration may start from. `processing` is a previous attempt that died mid-run; its
 * transaction rolled back, so it is as safe to resume as `failed`. */
const MIGRATABLE_STATUSES = ["confirmed", "processing", "failed"];

export async function processStudentImport(
  data: StudentImportJobData,
  databaseUrl: string,
  keyring: RecordKeyring,
): Promise<StudentImportSummary> {
  const sql = postgres(databaseUrl, { max: 2, idle_timeout: 20, prepare: false });
  try {
    return await migrateStagedImport(sql, data, keyring);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function migrateStagedImport(
  sql: Sql,
  { importId, schoolId }: StudentImportJobData,
  keyring: RecordKeyring,
): Promise<StudentImportSummary> {
  // Visible progress for the import page's poll. Committed on its own, ahead of the migration.
  await withSystemTenantTx(sql, { schoolId }, (tx) =>
    setStatus(tx, importId, "processing", ["confirmed", "failed"]),
  );

  try {
    return await withSystemTenantTx(sql, { schoolId }, (tx) =>
      migrate(tx, schoolId, importId, keyring),
    );
  } catch (error) {
    await withSystemTenantTx(sql, { schoolId }, (tx) =>
      setStatus(tx, importId, "failed", ["processing"]),
    ).catch(() => {
      // Best effort: the job's own failure is the error worth surfacing, not this one.
    });
    throw error;
  }
}

async function migrate(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
  keyring: RecordKeyring,
): Promise<StudentImportSummary> {
  // The row lock serializes attempts at this import: a second worker waits here, then sees the
  // first one's `completed`.
  const [target] = await tx<
    { status: string; summary: StudentImportSummary | null; confirmed_by: string | null }[]
  >`
    SELECT status, summary, confirmed_by
    FROM app.student_imports
    WHERE id = ${importId}::uuid AND school_id = ${schoolId}::uuid
    FOR UPDATE
  `;
  if (!target) throw new Error(`Import ${importId} not found`);
  if (target.status === "completed" && target.summary) return target.summary;
  if (!MIGRATABLE_STATUSES.includes(target.status)) {
    throw new Error(`Import ${importId} is ${target.status}, not confirmed`);
  }

  // Serializes imports within a school, so two imports never plan against each other's
  // uncommitted rows and then collide on a unique key.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`student-import:${schoolId}`}, 0))`;
  if (target.confirmed_by) {
    await tx`SELECT set_config('app.user_id', ${target.confirmed_by}, true)`;
  }

  const staged = await tx<{ line_number: number; record: StudentImportRecord }[]>`
    SELECT line_number, record
    FROM app.student_import_rows
    WHERE school_id = ${schoolId}::uuid AND import_id = ${importId}::uuid AND record IS NOT NULL
    ORDER BY line_number
  `;
  // Rows staged before ST-299 (backfilled from rows_data) have no parent_name key.
  const records: StagedRecord[] = staged.map((row) => ({
    line_number: row.line_number,
    record: { ...row.record, parent_name: row.record.parent_name ?? null },
  }));

  const plan = await planStudentImport(tx, schoolId, records);
  const recordForm = await loadRecordForm(tx, schoolId);
  const { summary, audit } = await applyPlan(tx, schoolId, importId, plan, recordForm, keyring);

  // The import is applied: its staged cells (the uploaded file, sensitive columns included) have
  // no further use, so they go in the same transaction that records the outcome.
  await tx`
    DELETE FROM app.student_import_rows
    WHERE school_id = ${schoolId}::uuid AND import_id = ${importId}::uuid
  `;

  await tx`
    UPDATE app.student_imports
    SET status = 'completed'::app.import_status,
        summary = ${tx.json({ ...summary })}::jsonb,
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${importId}::uuid AND school_id = ${schoolId}::uuid
  `;
  audit.push({
    action: "update",
    targetTable: "student_imports",
    targetId: importId,
    oldValues: { status: target.status },
    newValues: { status: "completed", summary },
  });
  await emitAuditLogs(tx, audit);

  return summary;
}

async function setStatus(
  tx: TransactionSql,
  importId: string,
  status: "processing" | "failed",
  from: string[],
): Promise<void> {
  await tx`
    UPDATE app.student_imports
    SET status = ${status}::app.import_status, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${importId}::uuid
      AND school_id = current_setting('app.school_id')::uuid
      AND status::text = ANY(${tx.array(from)}::text[])
  `;
}

// ---------------------------------------------------------------------------
// Applying the plan
// ---------------------------------------------------------------------------

interface ApplyContext {
  tx: TransactionSql;
  schoolId: string;
  importId: string;
  audit: WorkerAuditEntry[];
  /** Parent accounts created earlier in this run, by normalized email. */
  parentsByEmail: Map<string, string>;
  /** Each parent's household, once looked up or created in this run. */
  familiesByParent: Map<string, string>;
  /** The published student record form, by field id. */
  recordForm: Map<string, RecordFormField>;
  keyring: RecordKeyring;
}

interface RecordFormField {
  id: string;
  field_version_id: string;
  field_type: RecordFieldType;
  options: RecordFieldOption[];
  sensitivity: RecordFieldSensitivity;
}

/** The current published student record form; answers are written against it. */
async function loadRecordForm(
  tx: TransactionSql,
  schoolId: string,
): Promise<Map<string, RecordFormField>> {
  const fields = await tx<RecordFormField[]>`
    SELECT fv.field_id AS id, fv.id AS field_version_id, fv.field_type, fv.options, fv.sensitivity
    FROM app.record_templates AS t
    JOIN app.record_template_versions AS tv
      ON tv.template_id = t.id AND tv.school_id = t.school_id AND tv.version = t.published_version
    JOIN app.record_field_versions AS fv
      ON fv.template_version_id = tv.id AND fv.school_id = tv.school_id
    WHERE t.school_id = ${schoolId}::uuid AND t.subject_kind = 'student'
  `;
  return new Map(fields.map((field) => [field.id, field]));
}

async function applyPlan(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
  plan: StudentImportPlan,
  recordForm: Map<string, RecordFormField>,
  keyring: RecordKeyring,
): Promise<{ summary: StudentImportSummary; audit: WorkerAuditEntry[] }> {
  const ctx: ApplyContext = {
    tx,
    schoolId,
    importId,
    audit: [],
    parentsByEmail: new Map(),
    familiesByParent: new Map(),
    recordForm,
    keyring,
  };
  const summary: StudentImportSummary = {
    students_created: 0,
    students_updated: 0,
    students_skipped: 0,
    conflicts: 0,
    parents_created: 0,
    parents_linked: 0,
    parent_conflicts: 0,
    record_answers: 0,
  };

  for (const row of plan.rows) {
    if (row.action === "conflict" || row.action === "unchanged") {
      summary.students_skipped++;
      if (row.action === "conflict") summary.conflicts++;
      continue;
    }

    let studentId: string;
    if (row.action === "create") {
      studentId = await createStudent(ctx, row);
      summary.students_created++;
    } else {
      studentId = row.student_id!;
      await updateStudent(ctx, studentId, row);
      summary.students_updated++;
    }

    if (row.link === "create") {
      const { parentUserId, created } = await resolveParent(ctx, row);
      if (created) summary.parents_created++;
      await createLink(ctx, parentUserId, studentId, row.record);
      summary.parents_linked++;
    }
    if (row.parent_conflict !== null) summary.parent_conflicts++;

    summary.record_answers += await writeRecordAnswers(ctx, studentId, row.record.records ?? {});
  }

  return { summary, audit: ctx.audit };
}

async function createStudent(ctx: ApplyContext, row: PlannedRow): Promise<string> {
  const { tx, schoolId } = ctx;
  const record = row.record;
  const userId =
    row.user_id ??
    (await createUser(ctx, record.email, `${record.first_name} ${record.last_name}`));
  await grantRole(ctx, userId, "STUDENT");

  const [student] = await tx<{ id: string }[]>`
    INSERT INTO app.students (
      school_id, user_id, admission_number, first_name, middle_name,
      last_name, preferred_name, date_of_birth, admission_date, status
    ) VALUES (
      ${schoolId}::uuid, ${userId}::uuid, ${record.admission_number}, ${record.first_name},
      ${record.middle_name}, ${record.last_name}, ${record.preferred_name},
      ${record.date_of_birth}::date, CURRENT_DATE,
      ${record.status ?? "applicant"}::app.student_status
    )
    RETURNING id
  `;
  ctx.audit.push({
    action: "insert",
    targetTable: "students",
    targetId: student!.id,
    oldValues: null,
    newValues: {
      import_id: ctx.importId,
      user_id: userId,
      admission_number: record.admission_number,
      first_name: record.first_name,
      middle_name: record.middle_name,
      last_name: record.last_name,
      preferred_name: record.preferred_name,
      date_of_birth: record.date_of_birth,
      status: record.status ?? "applicant",
    },
  });
  return student!.id;
}

async function updateStudent(ctx: ApplyContext, studentId: string, row: PlannedRow): Promise<void> {
  const fields = Object.keys(row.changes) as (keyof PlannedRow["changes"])[];
  if (fields.length === 0) return; // Only the parent link changes.

  const next = (field: keyof PlannedRow["changes"]): string | null =>
    row.changes[field]?.to ?? null;
  await ctx.tx`
    UPDATE app.students
    SET first_name = COALESCE(${next("first_name")}, first_name),
        middle_name = COALESCE(${next("middle_name")}, middle_name),
        last_name = COALESCE(${next("last_name")}, last_name),
        preferred_name = COALESCE(${next("preferred_name")}, preferred_name),
        date_of_birth = COALESCE(${next("date_of_birth")}::date, date_of_birth),
        status = COALESCE(${next("status")}::app.student_status, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${studentId}::uuid AND school_id = ${ctx.schoolId}::uuid
  `;
  ctx.audit.push({
    action: "update",
    targetTable: "students",
    targetId: studentId,
    oldValues: Object.fromEntries(fields.map((field) => [field, row.changes[field]!.from])),
    newValues: {
      import_id: ctx.importId,
      ...Object.fromEntries(fields.map((field) => [field, row.changes[field]!.to])),
    },
  });
}

/**
 * The new parent a row links to: created by the first line naming its email ("create"), reused by
 * every later one ("sibling"). Never an existing account -- the plan has already refused those.
 */
async function resolveParent(
  ctx: ApplyContext,
  row: PlannedRow,
): Promise<{ parentUserId: string; created: boolean }> {
  const email = row.record.parent_email!;
  const normalized = normalizeEmail(email);
  const sibling = ctx.parentsByEmail.get(normalized);
  if (sibling) return { parentUserId: sibling, created: false };

  const parentUserId = await createUser(ctx, email, row.record.parent_name ?? email);
  await grantRole(ctx, parentUserId, "PARENT");
  ctx.parentsByEmail.set(normalized, parentUserId);
  return { parentUserId, created: true };
}

/**
 * Template columns for one student, against the form as published now (a field archived since
 * staging is skipped, and a value is re-validated in case its choices changed). A sensitive value
 * is sealed and its audit row names the field only.
 */
async function writeRecordAnswers(
  ctx: ApplyContext,
  studentId: string,
  records: Record<string, RecordValue>,
): Promise<number> {
  let written = 0;
  for (const [fieldId, raw] of Object.entries(records)) {
    const field = ctx.recordForm.get(fieldId);
    if (!field || field.field_type === "document") continue;
    const normalized = normalizeRecordValue(field, raw);
    if (!normalized.ok || normalized.value === null) continue;
    const value = normalized.value;
    const sensitive = field.sensitivity === "sensitive";
    const sealed = sensitive
      ? sealRecordValue(
          ctx.keyring,
          { schoolId: ctx.schoolId, subjectKind: "student", subjectId: studentId, fieldId },
          field.field_type,
          value,
        )
      : null;
    const [row] = await ctx.tx<{ id: string; inserted: boolean }[]>`
      INSERT INTO app.record_answers (
        school_id, subject_kind, student_id, field_id, field_version_id, value, value_ciphertext,
        value_key_id, value_mask, updated_by
      ) VALUES (
        ${ctx.schoolId}::uuid, 'student', ${studentId}::uuid, ${fieldId}::uuid,
        ${field.field_version_id}::uuid, ${sealed ? null : ctx.tx.json(value as never)}::jsonb,
        ${sealed?.ciphertext ?? null}::bytea, ${sealed?.keyId ?? null}, ${sealed?.mask ?? null},
        NULLIF(current_setting('app.user_id', true), '')::uuid
      )
      ON CONFLICT (school_id, subject_kind, subject_id, field_id) DO UPDATE SET
        field_version_id = EXCLUDED.field_version_id,
        value = EXCLUDED.value,
        value_ciphertext = EXCLUDED.value_ciphertext,
        value_key_id = EXCLUDED.value_key_id,
        value_mask = EXCLUDED.value_mask,
        updated_by = EXCLUDED.updated_by,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id, (xmax = 0) AS inserted
    `;
    ctx.audit.push({
      action: row!.inserted ? "insert" : "update",
      targetTable: "record_answers",
      targetId: row!.id,
      oldValues: row!.inserted
        ? null
        : { field_id: fieldId, ...(sensitive ? { sensitive: true } : {}) },
      newValues: sensitive
        ? { import_id: ctx.importId, field_id: fieldId, sensitive: true, changed: true }
        : { import_id: ctx.importId, field_id: fieldId, value },
    });
    written++;
  }
  return written;
}

async function createUser(ctx: ApplyContext, email: string, displayName: string): Promise<string> {
  const normalizedEmail = normalizeEmail(email);
  const [user] = await ctx.tx<{ id: string }[]>`
    INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
    VALUES (
      ${ctx.schoolId}::uuid, ${email}, ${normalizedEmail}, ${displayName}, 'active'::app.user_status
    )
    RETURNING id
  `;
  ctx.audit.push({
    action: "insert",
    targetTable: "users",
    targetId: user!.id,
    oldValues: null,
    newValues: { import_id: ctx.importId, email, display_name: displayName, status: "active" },
  });
  return user!.id;
}

async function grantRole(
  ctx: ApplyContext,
  userId: string,
  role: "STUDENT" | "PARENT",
): Promise<void> {
  const granted = await ctx.tx`
    INSERT INTO app.user_roles (school_id, user_id, role)
    VALUES (${ctx.schoolId}::uuid, ${userId}::uuid, ${role}::app.user_role)
    ON CONFLICT (school_id, user_id, role) DO NOTHING
    RETURNING user_id
  `;
  if (granted.length > 0) {
    ctx.audit.push({
      action: "insert",
      targetTable: "user_roles",
      targetId: userId,
      oldValues: null,
      newValues: { import_id: ctx.importId, role },
    });
  }
}

async function createLink(
  ctx: ApplyContext,
  parentUserId: string,
  studentId: string,
  record: StudentImportRecord,
): Promise<void> {
  const familyId = await resolveFamily(ctx, parentUserId, record);
  await ctx.tx`
    INSERT INTO app.parent_child_links
      (school_id, family_id, parent_user_id, student_id, relationship)
    VALUES (
      ${ctx.schoolId}::uuid, ${familyId}::uuid, ${parentUserId}::uuid, ${studentId}::uuid,
      ${record.parent_relationship}::app.parent_relationship
    )
  `;
  ctx.audit.push({
    action: "insert",
    targetTable: "parent_child_links",
    targetId: studentId,
    oldValues: null,
    newValues: {
      import_id: ctx.importId,
      family_id: familyId,
      parent_user_id: parentUserId,
      relationship: record.parent_relationship,
    },
  });
}

/** The parent's earliest household, or a new one named after them — the rule the families
 * migration (000072) used to backfill, and the one the pre-ST-299 import applied. */
async function resolveFamily(
  ctx: ApplyContext,
  parentUserId: string,
  record: StudentImportRecord,
): Promise<string> {
  const cached = ctx.familiesByParent.get(parentUserId);
  if (cached) return cached;

  const [existing] = await ctx.tx<{ id: string }[]>`
    SELECT id FROM app.families
    WHERE school_id = ${ctx.schoolId}::uuid AND primary_parent_user_id = ${parentUserId}::uuid
    ORDER BY created_at, id
    LIMIT 1
  `;
  let familyId = existing?.id;
  if (!familyId) {
    const displayName = (record.parent_name ?? record.parent_email!).slice(0, 200).trim();
    const [family] = await ctx.tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${ctx.schoolId}::uuid, ${displayName}, ${parentUserId}::uuid)
      RETURNING id
    `;
    familyId = family!.id;
    ctx.audit.push({
      action: "insert",
      targetTable: "families",
      targetId: familyId,
      oldValues: null,
      newValues: {
        import_id: ctx.importId,
        display_name: displayName,
        primary_parent_user_id: parentUserId,
      },
    });
  }
  ctx.familiesByParent.set(parentUserId, familyId);
  return familyId;
}
