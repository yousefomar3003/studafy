/**
 * Staging-to-target migration for confirmed student imports (ST-097, ST-299).
 *
 * The API stages every CSV line in app.student_import_rows, mapped and validated. This job moves the
 * valid ones into app.users / app.students / app.parent_child_links, and template columns into
 * app.record_answers (sensitive ones sealed, ADR-019). Once the import has completed, its staged
 * rows -- the uploaded file's cells -- are cut down in the same transaction to what a later column
 * mapping needs: the cells of columns the mapping did not read, on the lines whose student this run
 * created or updated (and whose parent it created), tagged with those ids. Everything else goes.
 * What is kept expires with the school's import retention period (import-source-retention-sweep.ts).
 *
 * Parents are never matched by email (docs/modules/finance-module-guide.md): a row whose parent
 * email belongs to an existing account imports its student with that parent unlinked
 * (PARENT_ACCOUNT_EXISTS). Which lines share a new parent -- the same family number, or else the
 * same new email -- is decided by the plan (packages/student-import/src/plan.ts); each shared parent
 * is created once, by the line the plan names, and a line's two parents share one household.
 *
 * Nobody needs an email: a student or parent created without one signs in with the member ID the
 * user_roles trigger issues (000140) and a password set from a setup code (000141, 000184).
 *
 * A row naming a grade (and section) places its student in that section of the current academic
 * year and enrolls them in the section's open classes, as placing them by hand does
 * (apps/api/src/modules/academics/section-service.ts placeStudentInSection).
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
import {
  normalizeEmail,
  PARENT_SLOTS,
  planStudentImport,
  unmappedColumns,
  withRecordDefaults,
} from "@studafy/student-import";

import { emitAuditLogs } from "../../db/audit";
import { withDatabase } from "../../db/pool";
import { withSystemTenantTx } from "../../db/tenant-tx";

import type { WorkerAuditEntry } from "../../db/audit";
import type { DatabaseSource } from "../../db/pool";
import type {
  RecordFieldOption,
  RecordFieldSensitivity,
  RecordFieldType,
  RecordKeyring,
  RecordValue,
} from "@studafy/records";
import type {
  ColumnMapping,
  ParentSlot,
  PlannedParent,
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
  /** Parents not linked (an existing account, or an email another family creates). */
  parent_conflicts: number;
  /** Students placed in, or moved to, a section. */
  placed: number;
  /** Students imported unplaced: unknown grade or section, or no academic year. */
  placement_conflicts: number;
  /** Student record answers written from template columns. */
  record_answers: number;
}

/** Statuses a migration may start from. `processing` is a previous attempt that died mid-run; its
 * transaction rolled back, so it is as safe to resume as `failed`. */
const MIGRATABLE_STATUSES = ["confirmed", "processing", "failed"];

export async function processStudentImport(
  data: StudentImportJobData,
  database: DatabaseSource,
  keyring: RecordKeyring,
): Promise<StudentImportSummary> {
  return withDatabase(database, (sql) => migrateStagedImport(sql, data, keyring));
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
    {
      status: string;
      summary: StudentImportSummary | null;
      confirmed_by: string | null;
      source_headers: string[];
      column_mapping: ColumnMapping;
    }[]
  >`
    SELECT status, summary, confirmed_by, source_headers, column_mapping
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
  // Rows staged by an earlier release lack the fields added since; missing means "not given".
  const records: StagedRecord[] = staged.map((row) => ({
    line_number: row.line_number,
    record: withRecordDefaults(row.record),
  }));

  const plan = await planStudentImport(tx, schoolId, records);
  const recordForm = await loadRecordForm(tx, schoolId);
  const { summary, audit, applied } = await applyPlan(
    tx,
    schoolId,
    importId,
    plan,
    recordForm,
    keyring,
  );

  await keepLeftoverCells(
    tx,
    schoolId,
    importId,
    applied,
    unmappedColumns(target.source_headers ?? [], target.column_mapping ?? {}).map(
      (column) => column.header,
    ),
  );

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

/**
 * The import is applied. Its staged cells (the uploaded file, sensitive columns included) are cut
 * down to the unmapped columns' non-empty cells on the lines this run wrote a student for, each line
 * tagged with that student (and the parent it created). Mapped cells already live in the records
 * they were written to; lines skipped as conflicts or unchanged wrote no one, so nothing of theirs
 * may later be applied to anyone. With no unmapped column, nothing is kept.
 */
async function keepLeftoverCells(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
  applied: readonly AppliedLine[],
  unmappedHeaders: readonly string[],
): Promise<void> {
  if (applied.length > 0 && unmappedHeaders.length > 0) {
    await tx`
      UPDATE app.student_import_rows AS staged
      SET student_id = line.student_id,
          parent_user_id = line.parent_user_id,
          parent2_user_id = line.parent2_user_id,
          record = NULL,
          source = coalesce(
            (SELECT jsonb_object_agg(cell.key, cell.value)
             FROM jsonb_each_text(staged.source) AS cell
             WHERE cell.key = ANY(${tx.array(unmappedHeaders as string[])}::text[])
               AND btrim(cell.value) <> ''),
            '{}'::jsonb
          )
      FROM jsonb_to_recordset(${tx.json(applied as never)}::jsonb)
        AS line (line_number int, student_id uuid, parent_user_id uuid, parent2_user_id uuid)
      WHERE staged.school_id = ${schoolId}::uuid
        AND staged.import_id = ${importId}::uuid
        AND staged.line_number = line.line_number
    `;
  }
  await tx`
    DELETE FROM app.student_import_rows
    WHERE school_id = ${schoolId}::uuid AND import_id = ${importId}::uuid
      AND (student_id IS NULL OR source = '{}'::jsonb)
  `;
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

/** A line this run wrote a student for, and the parents it linked on that line, if any. */
interface AppliedLine {
  line_number: number;
  student_id: string;
  parent_user_id: string | null;
  parent2_user_id: string | null;
}

interface ApplyContext {
  tx: TransactionSql;
  schoolId: string;
  importId: string;
  audit: WorkerAuditEntry[];
  /** Parent accounts created earlier in this run, by `<naming line>:<slot index>`. */
  parentsByGroup: Map<string, string>;
  /** Every planned line, by line number: a shared parent is created from its naming line. */
  linesByNumber: Map<number, PlannedRow>;
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
): Promise<{ summary: StudentImportSummary; audit: WorkerAuditEntry[]; applied: AppliedLine[] }> {
  const applied: AppliedLine[] = [];
  const ctx: ApplyContext = {
    tx,
    schoolId,
    importId,
    audit: [],
    parentsByGroup: new Map(),
    linesByNumber: new Map(plan.rows.map((row) => [row.line_number, row])),
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
    placed: 0,
    placement_conflicts: 0,
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

    // Both of the line's parents join one household: the first linked parent's.
    let householdId: string | null = null;
    const linked: (string | null)[] = [];
    for (const [index, slot] of PARENT_SLOTS.entries()) {
      const parent = index === 0 ? row.parent1 : row.parent2;
      if (parent?.parent_conflict) summary.parent_conflicts++;
      if (parent?.link !== "create") {
        linked.push(null);
        continue;
      }
      const resolved = await resolveParent(ctx, parent, slot, index);
      if (resolved.created) summary.parents_created++;
      householdId ??= await resolveFamily(ctx, resolved.parentUserId, resolved.namedBy, slot);
      await createLink(ctx, resolved.parentUserId, studentId, householdId, parent.relationship!);
      summary.parents_linked++;
      linked.push(resolved.parentUserId);
    }

    if (row.placement_conflict !== null) summary.placement_conflicts++;
    if (row.placement !== null && row.placement.action !== "unchanged") {
      await placeStudent(ctx, studentId, row.placement);
      summary.placed++;
    }

    summary.record_answers += await writeRecordAnswers(ctx, studentId, row.record.records ?? {});
    applied.push({
      line_number: row.line_number,
      student_id: studentId,
      parent_user_id: linked[0] ?? null,
      parent2_user_id: linked[1] ?? null,
    });
  }

  return { summary, audit: ctx.audit, applied };
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
 * The new parent a line links to, created from the details on the line the plan names for it
 * (parent_group_line) the first time any line of its group needs it -- which can be a blank family
 * line ahead of the one naming the parent. Never an existing account: the plan refused those.
 */
async function resolveParent(
  ctx: ApplyContext,
  parent: PlannedParent,
  slot: ParentSlot,
  index: number,
): Promise<{ parentUserId: string; created: boolean; namedBy: StudentImportRecord }> {
  const namedBy = ctx.linesByNumber.get(parent.parent_group_line!)!.record;
  const group = `${parent.parent_group_line}:${index}`;
  const existing = ctx.parentsByGroup.get(group);
  if (existing) return { parentUserId: existing, created: false, namedBy };

  const email = namedBy[slot.email];
  const displayName = (namedBy[slot.name] ?? email!).slice(0, 200).trim();
  const parentUserId = await createUser(ctx, email, displayName, namedBy[slot.phone]);
  await grantRole(ctx, parentUserId, "PARENT");
  ctx.parentsByGroup.set(group, parentUserId);
  return { parentUserId, created: true, namedBy };
}

/**
 * Places a student in a section of the current academic year and enrolls them in its open
 * classes; a student in another section of that year is moved out of its classes first. A class
 * at capacity is skipped, as placing by hand does. Mirrors placeStudentInSection (API).
 */
async function placeStudent(
  ctx: ApplyContext,
  studentId: string,
  placement: NonNullable<PlannedRow["placement"]>,
): Promise<void> {
  const { tx, schoolId } = ctx;
  const [previous] = await tx<{ section_id: string }[]>`
    SELECT section_id FROM app.student_sections
    WHERE school_id = ${schoolId}::uuid AND student_id = ${studentId}::uuid
      AND academic_year_id = ${placement.academic_year_id}::uuid
    FOR UPDATE
  `;
  if (previous && previous.section_id !== placement.section_id) {
    await tx`
      UPDATE app.enrollments AS e
      SET status = 'withdrawn'::app.enrollment_status,
          withdrawn_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      FROM app.classes AS cl
      WHERE cl.id = e.class_id AND cl.school_id = e.school_id
        AND cl.section_id = ${previous.section_id}::uuid
        AND e.school_id = ${schoolId}::uuid AND e.student_id = ${studentId}::uuid
        AND e.status IN ('active', 'waitlisted')
    `;
  }

  await tx`
    INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
    VALUES (
      ${schoolId}::uuid, ${studentId}::uuid, ${placement.academic_year_id}::uuid,
      ${placement.section_id}::uuid
    )
    ON CONFLICT (school_id, student_id, academic_year_id)
    DO UPDATE SET section_id = EXCLUDED.section_id, updated_at = CURRENT_TIMESTAMP
  `;

  // One statement per student: each open class of the section with room left, new enrollments
  // inserted and withdrawn ones re-activated. Earlier students of this run count toward capacity,
  // since they were written in this same transaction.
  const enrolled = await tx<{ class_id: string }[]>`
    INSERT INTO app.enrollments (school_id, class_id, student_id)
    SELECT cl.school_id, cl.id, ${studentId}::uuid
    FROM app.classes AS cl
    WHERE cl.school_id = ${schoolId}::uuid AND cl.section_id = ${placement.section_id}::uuid
      AND cl.status IN ('planned', 'active')
      AND (
        cl.capacity IS NULL
        OR (SELECT count(*) FROM app.enrollments AS taken
            WHERE taken.school_id = cl.school_id AND taken.class_id = cl.id
              AND taken.status = 'active') < cl.capacity
      )
    ON CONFLICT (school_id, class_id, student_id) DO UPDATE
      SET status = 'active'::app.enrollment_status,
          enrolled_at = CURRENT_TIMESTAMP,
          withdrawn_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE app.enrollments.status NOT IN ('active', 'waitlisted')
    RETURNING class_id
  `;

  ctx.audit.push({
    action: previous ? "update" : "insert",
    targetTable: "student_sections",
    targetId: studentId,
    oldValues: previous ? { section_id: previous.section_id } : null,
    newValues: {
      import_id: ctx.importId,
      section_id: placement.section_id,
      enrolled_class_ids: enrolled.map((row) => row.class_id),
    },
  });
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

/** A new active account. With no email, its owner signs in with their member ID (000141). */
/**
 * A new account. `phone` is a parent's contact number (000203); null for a student, and for a
 * parent staged before parents' phones were imported.
 */
async function createUser(
  ctx: ApplyContext,
  email: string | null,
  displayName: string,
  phone: string | null = null,
): Promise<string> {
  const normalizedEmail = email === null ? null : normalizeEmail(email);
  const [user] = await ctx.tx<{ id: string }[]>`
    INSERT INTO app.users (school_id, email, normalized_email, display_name, phone, status)
    VALUES (
      ${ctx.schoolId}::uuid, ${email}, ${normalizedEmail}, ${displayName}, ${phone},
      'active'::app.user_status
    )
    RETURNING id
  `;
  ctx.audit.push({
    action: "insert",
    targetTable: "users",
    targetId: user!.id,
    oldValues: null,
    // Whether a phone was saved, not the number: the audit trail is kept for years.
    newValues: {
      import_id: ctx.importId,
      email,
      display_name: displayName,
      phone_set: phone !== null,
      status: "active",
    },
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
  familyId: string,
  relationship: string,
): Promise<void> {
  await ctx.tx`
    INSERT INTO app.parent_child_links
      (school_id, family_id, parent_user_id, student_id, relationship)
    VALUES (
      ${ctx.schoolId}::uuid, ${familyId}::uuid, ${parentUserId}::uuid, ${studentId}::uuid,
      ${relationship}::app.parent_relationship
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
      relationship,
    },
  });
}

/** The parent's earliest household, or a new one named after them — the rule the families
 * migration (000072) used to backfill, and the one the pre-ST-299 import applied. */
async function resolveFamily(
  ctx: ApplyContext,
  parentUserId: string,
  record: StudentImportRecord,
  slot: ParentSlot,
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
    const displayName = (record[slot.name] ?? record[slot.email]!).slice(0, 200).trim();
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
