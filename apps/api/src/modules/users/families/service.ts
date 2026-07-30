import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { TransactionSql } from "postgres";

export interface FamilyRow {
  id: string;
  school_id: string;
  display_name: string;
  primary_parent_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface FamilyLinkRow {
  family_id: string;
  parent_user_id: string;
  student_id: string;
  relationship:
    "mother" | "father" | "guardian" | "step_parent" | "grandparent" | "sibling" | "other";
  created_at: Date;
  updated_at: Date;
}

async function assertParent(tx: TransactionSql, schoolId: string, parentUserId: string) {
  const [parent] = await tx<{ id: string }[]>`
    SELECT user_row.id
    FROM app.users AS user_row
    JOIN app.user_roles AS role
      ON role.school_id = user_row.school_id
     AND role.user_id = user_row.id
     AND role.role = 'PARENT'::app.user_role
    WHERE user_row.school_id = ${schoolId}::uuid
      AND user_row.id = ${parentUserId}::uuid
  `;
  if (!parent) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.PARENT_INVALID_ROLE,
      "User does not have the PARENT role.",
    );
  }
}

async function assertStudent(tx: TransactionSql, schoolId: string, studentId: string) {
  const [student] = await tx<{ id: string }[]>`
    SELECT id
    FROM app.students
    WHERE school_id = ${schoolId}::uuid
      AND id = ${studentId}::uuid
  `;
  if (!student) throw new HTTPException(404, { message: "Student not found" });
}

export async function createFamily(
  tx: TransactionSql,
  schoolId: string,
  displayName: string,
  primaryParentUserId: string,
): Promise<FamilyRow> {
  await assertParent(tx, schoolId, primaryParentUserId);
  const [row] = await tx<FamilyRow[]>`
    INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
    VALUES (${schoolId}::uuid, ${displayName.trim()}, ${primaryParentUserId}::uuid)
    RETURNING id, school_id, display_name, primary_parent_user_id, created_at, updated_at
  `;
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "families",
    targetId: row!.id,
    newValues: { display_name: row!.display_name, primary_parent_user_id: primaryParentUserId },
  });
  return row!;
}

export async function listFamilies(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  canManage: boolean,
  options: { search?: string; limit: number; offset: number },
): Promise<{ rows: FamilyRow[]; total: number }> {
  const access = canManage
    ? tx``
    : tx`AND (
        family.primary_parent_user_id = ${userId}::uuid
        OR EXISTS (
          SELECT 1
          FROM app.parent_child_links AS link
          WHERE link.school_id = family.school_id
            AND link.family_id = family.id
            AND link.parent_user_id = ${userId}::uuid
        )
      )`;
  const search = options.search ? tx`AND family.display_name ILIKE ${`%${options.search}%`}` : tx``;

  const rows = await tx<FamilyRow[]>`
    SELECT family.id, family.school_id, family.display_name,
           family.primary_parent_user_id, family.created_at, family.updated_at
    FROM app.families AS family
    WHERE family.school_id = ${schoolId}::uuid
      ${access}
      ${search}
    ORDER BY family.created_at DESC, family.id
    LIMIT ${options.limit} OFFSET ${options.offset}
  `;
  const [count] = await tx<{ total: number }[]>`
    SELECT count(*)::int AS total
    FROM app.families AS family
    WHERE family.school_id = ${schoolId}::uuid
      ${access}
      ${search}
  `;
  return { rows, total: count?.total ?? 0 };
}

export async function getFamily(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
  userId: string,
  canManage: boolean,
): Promise<(FamilyRow & { links: FamilyLinkRow[] }) | undefined> {
  const access = canManage
    ? tx``
    : tx`AND (
        family.primary_parent_user_id = ${userId}::uuid
        OR EXISTS (
          SELECT 1 FROM app.parent_child_links AS own_link
          WHERE own_link.school_id = family.school_id
            AND own_link.family_id = family.id
            AND own_link.parent_user_id = ${userId}::uuid
        )
      )`;
  const [family] = await tx<FamilyRow[]>`
    SELECT family.id, family.school_id, family.display_name,
           family.primary_parent_user_id, family.created_at, family.updated_at
    FROM app.families AS family
    WHERE family.school_id = ${schoolId}::uuid
      AND family.id = ${familyId}::uuid
      ${access}
  `;
  if (!family) return undefined;
  const links = await tx<FamilyLinkRow[]>`
    SELECT family_id, parent_user_id, student_id, relationship, created_at, updated_at
    FROM app.parent_child_links
    WHERE school_id = ${schoolId}::uuid
      AND family_id = ${familyId}::uuid
    ORDER BY created_at, parent_user_id, student_id
  `;
  return { ...family, links };
}

export async function updateFamily(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
  changes: { displayName?: string; primaryParentUserId?: string },
): Promise<FamilyRow> {
  if (changes.primaryParentUserId) await assertParent(tx, schoolId, changes.primaryParentUserId);
  const [existing] = await tx<FamilyRow[]>`
    SELECT id, school_id, display_name, primary_parent_user_id, created_at, updated_at
    FROM app.families
    WHERE school_id = ${schoolId}::uuid AND id = ${familyId}::uuid
  `;
  if (!existing) throw new HTTPException(404, { message: "Family not found" });
  const [row] = await tx<FamilyRow[]>`
    UPDATE app.families
    SET display_name = COALESCE(${changes.displayName?.trim() ?? null}, display_name),
        primary_parent_user_id =
          COALESCE(${changes.primaryParentUserId ?? null}::uuid, primary_parent_user_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid
      AND id = ${familyId}::uuid
    RETURNING id, school_id, display_name, primary_parent_user_id, created_at, updated_at
  `;
  if (!row) throw new HTTPException(404, { message: "Family not found" });
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "families",
    targetId: familyId,
    oldValues: {
      display_name: existing.display_name,
      primary_parent_user_id: existing.primary_parent_user_id,
    },
    newValues: {
      display_name: row.display_name,
      primary_parent_user_id: row.primary_parent_user_id,
    },
  });
  return row;
}

export async function deleteFamily(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
): Promise<void> {
  const [family] = await tx<{ display_name: string; primary_parent_user_id: string }[]>`
    SELECT display_name, primary_parent_user_id
    FROM app.families
    WHERE school_id = ${schoolId}::uuid AND id = ${familyId}::uuid
  `;
  if (!family) throw new HTTPException(404, { message: "Family not found" });
  const [links] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM app.parent_child_links
    WHERE school_id = ${schoolId}::uuid
      AND family_id = ${familyId}::uuid
  `;
  if ((links?.count ?? 0) > 0) {
    throw new HTTPException(409, {
      message: "Remove or move all family links before deleting the family",
    });
  }
  await tx`
    DELETE FROM app.families
    WHERE school_id = ${schoolId}::uuid
      AND id = ${familyId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "families",
    targetId: familyId,
    oldValues: {
      display_name: family.display_name,
      primary_parent_user_id: family.primary_parent_user_id,
    },
  });
}

export async function createFamilyLink(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
  parentUserId: string,
  studentId: string,
  relationship: FamilyLinkRow["relationship"],
): Promise<FamilyLinkRow> {
  const [family] = await tx<{ id: string }[]>`
    SELECT id FROM app.families
    WHERE school_id = ${schoolId}::uuid AND id = ${familyId}::uuid
  `;
  if (!family) throw new HTTPException(404, { message: "Family not found" });
  await Promise.all([
    assertParent(tx, schoolId, parentUserId),
    assertStudent(tx, schoolId, studentId),
  ]);
  try {
    const [row] = await tx<FamilyLinkRow[]>`
      INSERT INTO app.parent_child_links
        (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (
        ${schoolId}::uuid, ${familyId}::uuid, ${parentUserId}::uuid,
        ${studentId}::uuid, ${relationship}::app.parent_relationship
      )
      RETURNING family_id, parent_user_id, student_id, relationship, created_at, updated_at
    `;
    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "parent_child_links",
      targetId: studentId,
      newValues: { family_id: familyId, parent_user_id: parentUserId, relationship },
    });
    return row!;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new CodedHttpException(
        409,
        ERROR_CODES.PARENT_LINK_EXISTS,
        "This parent is already linked to this student.",
      );
    }
    throw error;
  }
}

export async function updateFamilyLink(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
  parentUserId: string,
  studentId: string,
  changes: { targetFamilyId?: string; relationship?: FamilyLinkRow["relationship"] },
): Promise<FamilyLinkRow> {
  if (changes.targetFamilyId) {
    const [target] = await tx<{ id: string }[]>`
      SELECT id FROM app.families
      WHERE school_id = ${schoolId}::uuid AND id = ${changes.targetFamilyId}::uuid
    `;
    if (!target) throw new HTTPException(404, { message: "Target family not found" });
  }
  const [existing] = await tx<FamilyLinkRow[]>`
    SELECT family_id, parent_user_id, student_id, relationship, created_at, updated_at
    FROM app.parent_child_links
    WHERE school_id = ${schoolId}::uuid
      AND family_id = ${familyId}::uuid
      AND parent_user_id = ${parentUserId}::uuid
      AND student_id = ${studentId}::uuid
  `;
  if (!existing) throw new HTTPException(404, { message: "Family link not found" });
  const [row] = await tx<FamilyLinkRow[]>`
    UPDATE app.parent_child_links
    SET family_id = COALESCE(${changes.targetFamilyId ?? null}::uuid, family_id),
        relationship =
          COALESCE(${changes.relationship ?? null}::app.parent_relationship, relationship),
        updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid
      AND family_id = ${familyId}::uuid
      AND parent_user_id = ${parentUserId}::uuid
      AND student_id = ${studentId}::uuid
    RETURNING family_id, parent_user_id, student_id, relationship, created_at, updated_at
  `;
  if (!row) throw new HTTPException(404, { message: "Family link not found" });
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "parent_child_links",
    targetId: studentId,
    oldValues: {
      family_id: existing.family_id,
      parent_user_id: existing.parent_user_id,
      relationship: existing.relationship,
    },
    newValues: {
      family_id: row.family_id,
      parent_user_id: parentUserId,
      relationship: row.relationship,
    },
  });
  return row;
}

export async function deleteFamilyLink(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
  parentUserId: string,
  studentId: string,
): Promise<void> {
  const rows = await tx<{ relationship: string }[]>`
    DELETE FROM app.parent_child_links
    WHERE school_id = ${schoolId}::uuid
      AND family_id = ${familyId}::uuid
      AND parent_user_id = ${parentUserId}::uuid
      AND student_id = ${studentId}::uuid
    RETURNING relationship::text AS relationship
  `;
  if (rows.length === 0) throw new HTTPException(404, { message: "Family link not found" });
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "parent_child_links",
    targetId: studentId,
    oldValues: { family_id: familyId, parent_user_id: parentUserId },
  });
}
