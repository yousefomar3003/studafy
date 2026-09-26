/**
 * Staging-to-target migration for confirmed student imports (ST-097, ST-299).
 *
 * The API stages every CSV line in app.student_import_rows, mapped and validated. This job moves the
 * valid ones into app.users / app.students / app.parent_child_links.
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

import { normalizeEmail, planStudentImport } from "@studafy/student-import";
import postgres from "postgres";

import { emitAuditLogs } from "../../db/audit";
import { withSystemTenantTx } from "../../db/tenant-tx";

import type { WorkerAuditEntry } from "../../db/audit";
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
}

/** Statuses a migration may start from. `processing` is a previous attempt that died mid-run; its
 * transaction rolled back, so it is as safe to resume as `failed`. */
const MIGRATABLE_STATUSES = ["confirmed", "processing", "failed"];

export async function processStudentImport(
  data: StudentImportJobData,
  databaseUrl: string,
): Promise<StudentImportSummary> {
  const sql = postgres(databaseUrl, { max: 2, idle_timeout: 20, prepare: false });
  try {
    return await migrateStagedImport(sql, data);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function migrateStagedImport(
  sql: Sql,
  { importId, schoolId }: StudentImportJobData,
): Promise<StudentImportSummary> {
  // Visible progress for the import page's poll. Committed on its own, ahead of the migration.
  await withSystemTenantTx(sql, { schoolId }, (tx) =>
    setStatus(tx, importId, "processing", ["confirmed", "failed"]),
  );

  try {
    return await withSystemTenantTx(sql, { schoolId }, (tx) => migrate(tx, schoolId, importId));
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
  const { summary, audit } = await applyPlan(tx, schoolId, importId, plan);

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
}

async function applyPlan(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
  plan: StudentImportPlan,
): Promise<{ summary: StudentImportSummary; audit: WorkerAuditEntry[] }> {
  const ctx: ApplyContext = {
    tx,
    schoolId,
    importId,
    audit: [],
    parentsByEmail: new Map(),
    familiesByParent: new Map(),
  };
  const summary: StudentImportSummary = {
    students_created: 0,
    students_updated: 0,
    students_skipped: 0,
    conflicts: 0,
    parents_created: 0,
    parents_linked: 0,
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

    if (row.link === "create" || row.link === "update") {
      const { parentUserId, created } = await resolveParent(ctx, row);
      if (created) summary.parents_created++;
      if (row.link === "create") {
        await createLink(ctx, parentUserId, studentId, row.record);
        summary.parents_linked++;
      } else {
        await updateLinkRelationship(ctx, parentUserId, studentId, row.record);
      }
    }
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

async function resolveParent(
  ctx: ApplyContext,
  row: PlannedRow,
): Promise<{ parentUserId: string; created: boolean }> {
  const email = row.record.parent_email!;
  const normalized = normalizeEmail(email);
  const known = row.parent_user_id ?? ctx.parentsByEmail.get(normalized);
  if (known) {
    await grantRole(ctx, known, "PARENT");
    return { parentUserId: known, created: false };
  }

  const parentUserId = await createUser(ctx, email, row.record.parent_name ?? email);
  await grantRole(ctx, parentUserId, "PARENT");
  ctx.parentsByEmail.set(normalized, parentUserId);
  return { parentUserId, created: true };
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

async function updateLinkRelationship(
  ctx: ApplyContext,
  parentUserId: string,
  studentId: string,
  record: StudentImportRecord,
): Promise<void> {
  const [previous] = await ctx.tx<{ relationship: string }[]>`
    SELECT relationship::text AS relationship
    FROM app.parent_child_links
    WHERE school_id = ${ctx.schoolId}::uuid
      AND parent_user_id = ${parentUserId}::uuid
      AND student_id = ${studentId}::uuid
    FOR UPDATE
  `;
  await ctx.tx`
    UPDATE app.parent_child_links
    SET relationship = ${record.parent_relationship}::app.parent_relationship,
        updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${ctx.schoolId}::uuid
      AND parent_user_id = ${parentUserId}::uuid
      AND student_id = ${studentId}::uuid
  `;
  ctx.audit.push({
    action: "update",
    targetTable: "parent_child_links",
    targetId: studentId,
    oldValues: { parent_user_id: parentUserId, relationship: previous!.relationship },
    newValues: {
      import_id: ctx.importId,
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
