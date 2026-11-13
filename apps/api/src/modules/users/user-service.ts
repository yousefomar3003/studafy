import { PLATFORM_ROLES, canChangeRoleOf, isPlatformRole } from "@studafy/constants";
import { normalizePhoneNumber } from "@studafy/records";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../db/tenant-tx";
import { decodeKeysetCursor, encodeKeysetCursor } from "../../lib/keyset-cursor";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { MEMBER_PASSWORD_ROLES } from "../auth/services/member-password-service";
import { adminRevokeUserSessions, REVOCATION_REASONS } from "../auth/services/revocation-service";

import { linkParentToStudent } from "./student-service";

import type { ParentRelationship } from "./student-service";
import type { Database } from "../../db/client";
import type { TenantContext } from "../../db/tenant-tx";
import type { Logger } from "../../logger";
import type { JtiDenylist } from "../auth/denylist";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserStatus = "invited" | "active" | "suspended" | "archived";

export interface UserRow {
  id: string;
  school_id: string;
  email: string | null;
  display_name: string | null;
  phone: string | null;
  status: UserStatus;
  email_verified_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserWithRolesRow extends UserRow {
  roles: Role[];
}

export interface UserListRow extends UserWithRolesRow {
  member_codes: string[];
}

export interface ListUsersParams {
  limit: number;
  cursor?: string;
  role?: Role;
  status?: UserStatus;
  search?: string;
  created_from?: string;
  created_to?: string;
}

export interface CreateUserParams {
  email?: string;
  display_name?: string;
  /** Contact phone as typed; saved as normalizePhoneNumber reads it. */
  phone?: string;
  role: Role;
  /** PARENT only: students to link the new parent to. The caller has checked `parent:link`. */
  children?: { student_id: string; relationship: ParentRelationship }[];
}

export interface UpdateUserParams {
  display_name?: string;
  /** Null removes the phone; undefined leaves it as it is. */
  phone?: string | null;
  status?: UserStatus;
}

export interface UpdateUserRoleParams {
  role: Role;
  /** The caller's roles: only a SUPER_ADMIN may re-role a platform-role holder. */
  callerRoles: readonly string[];
}

// The request schemas already refuse platform roles (users/schemas.ts assignableRoleSchema); this is
// the service's own floor for any other caller (QA-10, finding F-01).
function assertAssignable(role: Role): void {
  if (isPlatformRole(role)) {
    throw new HTTPException(403, {
      message: "SUPER_ADMIN and SUPPORT_AGENT cannot be assigned to a school user.",
    });
  }
}

export interface DeactivateUserParams {
  database: Database;
  denylist: JtiDenylist | null;
  tenant: TenantContext;
  targetUserId: string;
  log?: Logger;
  userAgent?: string | null;
  clientIp?: string | null;
}

export interface DeactivateUserResult {
  status: "suspended";
  revoked: number;
  denylisted: number;
  invitations_revoked: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Studafy's own staff (SUPER_ADMIN, SUPPORT_AGENT) can sit in a school's tenant — the demo school's
 * super admin does — but they are Studafy, not the school: a school's user list and counts never
 * show them. `u` is the `app.users` row being filtered.
 */
function notPlatformStaff(tx: TransactionSql) {
  return tx`NOT EXISTS (
    SELECT 1 FROM app.user_roles pr
    WHERE pr.user_id = u.id AND pr.role = ANY(${[...PLATFORM_ROLES]}::app.user_role[])
  )`;
}

export async function listUsers(
  tx: TransactionSql,
  schoolId: string,
  params: ListUsersParams,
): Promise<{ rows: UserListRow[]; next_cursor: string | null }> {
  const statusFilter = params.status ? tx` AND u.status = ${params.status}::app.user_status` : tx``;

  const searchFilter = params.search
    ? tx` AND (u.display_name ILIKE ${`%${params.search}%`} OR u.email ILIKE ${`%${params.search}%`}
             OR EXISTS (SELECT 1 FROM app.member_codes mc
                        WHERE mc.user_id = u.id AND mc.code ILIKE ${`%${params.search}%`}))`
    : tx``;

  const createdFromFilter = params.created_from
    ? tx` AND u.created_at >= ${params.created_from}::timestamptz`
    : tx``;

  const createdToFilter = params.created_to
    ? tx` AND u.created_at <= ${params.created_to}::timestamptz`
    : tx``;

  const roleFilter = params.role
    ? tx` AND EXISTS (
        SELECT 1 FROM app.user_roles ur
        WHERE ur.user_id = u.id AND ur.school_id = u.school_id AND ur.role = ${params.role}::app.user_role
      )`
    : tx``;

  const cursorFilter = params.cursor
    ? (() => {
        const { created_at, id } = decodeKeysetCursor(params.cursor);
        return tx` AND (u.created_at, u.id) < (${created_at}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  const limit = params.limit + 1; // fetch one extra to detect next page

  const rows = await tx<UserListRow[]>`
    SELECT u.id, u.school_id, u.email, u.display_name, u.phone, u.status,
           u.email_verified_at, u.last_login_at, u.created_at, u.updated_at,
           COALESCE(
             ARRAY_AGG(ur.role ORDER BY ur.created_at) FILTER (WHERE ur.role IS NOT NULL),
             '{}'
           ) AS roles,
           ARRAY(SELECT mc.code FROM app.member_codes mc
                 WHERE mc.user_id = u.id ORDER BY mc.kind) AS member_codes
    FROM app.users u
    LEFT JOIN app.user_roles ur ON ur.user_id = u.id AND ur.school_id = u.school_id
    WHERE u.school_id = ${schoolId}
      AND ${notPlatformStaff(tx)}
      ${statusFilter}
      ${searchFilter}
      ${createdFromFilter}
      ${createdToFilter}
      ${roleFilter}
      ${cursorFilter}
    GROUP BY u.id, u.school_id, u.email, u.display_name, u.phone, u.status,
             u.email_verified_at, u.last_login_at, u.created_at, u.updated_at
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT ${limit}
  `;

  const hasMore = rows.length > params.limit;
  const sliced = hasMore ? rows.slice(0, params.limit) : rows;
  const next_cursor =
    hasMore && sliced.length > 0
      ? encodeKeysetCursor(sliced[sliced.length - 1]!.created_at, sliced[sliced.length - 1]!.id)
      : null;

  return {
    rows: sliced.map((row) => ({
      ...row,
      status: row.status as UserStatus,
      roles: (row.roles ?? []) as Role[],
      member_codes: row.member_codes ?? [],
    })),
    next_cursor,
  };
}

const ZERO_STATUS_COUNTS: Record<UserStatus, number> = {
  invited: 0,
  active: 0,
  suspended: 0,
  archived: 0,
};

/**
 * Counts users per lifecycle status for the school, e.g. to power an activation funnel tile
 * without paging through the full user list to total a status client-side.
 */
export async function getUserStatusCounts(
  tx: TransactionSql,
  schoolId: string,
): Promise<Record<UserStatus, number>> {
  const rows = await tx<{ status: UserStatus; count: string }[]>`
    SELECT u.status, COUNT(*) AS count
    FROM app.users u
    WHERE u.school_id = ${schoolId}
      AND ${notPlatformStaff(tx)}
    GROUP BY u.status
  `;

  const counts = { ...ZERO_STATUS_COUNTS };
  for (const row of rows) {
    counts[row.status] = Number(row.count);
  }
  return counts;
}

/**
 * The school's number and how many students, teachers and parents it has (distinct users holding
 * each role). Each of them holds a member ID (000140) prefixed STU/TCH/PAR plus the school number.
 */
export async function getUserMemberSummary(
  tx: TransactionSql,
  schoolId: string,
): Promise<{
  school_number: number;
  students: number;
  teachers: number;
  parents: number;
  attendance_officers: number;
}> {
  const [row] = await tx<
    {
      school_number: number;
      students: number;
      teachers: number;
      parents: number;
      attendance_officers: number;
    }[]
  >`
    SELECT s.school_number,
      (SELECT count(*)::int FROM app.user_roles WHERE school_id = s.id AND role = 'STUDENT') AS students,
      (SELECT count(*)::int FROM app.user_roles WHERE school_id = s.id AND role = 'INSTRUCTOR') AS teachers,
      (SELECT count(*)::int FROM app.user_roles WHERE school_id = s.id AND role = 'PARENT') AS parents,
      (SELECT count(*)::int FROM app.user_roles
       WHERE school_id = s.id AND role = 'ATTENDANCE_OFFICER') AS attendance_officers
    FROM app.schools s
    WHERE s.id = ${schoolId}
  `;
  if (!row) throw new HTTPException(404, { message: "School not found" });
  return row;
}

export async function getUser(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
): Promise<UserListRow | undefined> {
  const [row] = await tx<UserListRow[]>`
    SELECT u.id, u.school_id, u.email, u.display_name, u.phone, u.status,
           u.email_verified_at, u.last_login_at, u.created_at, u.updated_at,
           COALESCE(
             ARRAY_AGG(ur.role ORDER BY ur.created_at) FILTER (WHERE ur.role IS NOT NULL),
             '{}'
           ) AS roles,
           ARRAY(SELECT mc.code FROM app.member_codes mc
                 WHERE mc.user_id = u.id ORDER BY mc.kind) AS member_codes
    FROM app.users u
    LEFT JOIN app.user_roles ur ON ur.user_id = u.id AND ur.school_id = u.school_id
    WHERE u.id = ${userId}::uuid AND u.school_id = ${schoolId}
    GROUP BY u.id, u.school_id, u.email, u.display_name, u.phone, u.status,
             u.email_verified_at, u.last_login_at, u.created_at, u.updated_at
  `;
  if (!row) return undefined;
  return {
    ...row,
    status: row.status as UserStatus,
    roles: (row.roles ?? []) as Role[],
    member_codes: row.member_codes ?? [],
  };
}

export async function createUser(
  tx: TransactionSql,
  schoolId: string,
  params: CreateUserParams,
): Promise<UserListRow> {
  assertAssignable(params.role);
  if (!params.email && !MEMBER_PASSWORD_ROLES.includes(params.role)) {
    throw new HTTPException(400, {
      message: "An email is required for roles that sign in with Google or Microsoft.",
    });
  }
  if (params.children?.length && params.role !== "PARENT") {
    throw new HTTPException(400, { message: "Only a PARENT user can be linked to children." });
  }
  const email = params.email?.trim() || null;
  const normalizedEmail = email?.toLowerCase() ?? null;

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.users (school_id, email, normalized_email, display_name, phone, status)
    VALUES (
      ${schoolId},
      ${email},
      ${normalizedEmail},
      ${params.display_name ?? null},
      ${params.phone === undefined ? null : normalizePhoneNumber(params.phone)},
      'invited'::app.user_status
    )
    RETURNING id
  `;

  if (!row) {
    throw new HTTPException(500, { message: "Failed to create user" });
  }

  await tx`
    INSERT INTO app.user_roles (school_id, user_id, role)
    VALUES (${schoolId}, ${row.id}, ${params.role}::app.user_role)
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "users",
    targetId: row.id,
    newValues: {
      email,
      display_name: params.display_name ?? null,
      status: "invited",
    },
  });

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "user_roles",
    targetId: row.id,
    newValues: {
      role: params.role,
    },
  });

  // Same transaction: a child that cannot be linked rolls the new account back with it.
  for (const child of params.children ?? []) {
    await linkParentToStudent(tx, schoolId, child.student_id, row.id, child.relationship);
  }

  const user = await getUser(tx, schoolId, row.id);
  if (!user) {
    throw new HTTPException(500, { message: "Failed to retrieve created user" });
  }

  return user;
}

export async function updateUser(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: UpdateUserParams,
): Promise<UserWithRolesRow> {
  const existing = await getUser(tx, schoolId, userId);
  if (!existing) {
    throw new HTTPException(404, { message: "User not found" });
  }

  const phoneGiven = params.phone !== undefined;
  const phone = params.phone == null ? null : normalizePhoneNumber(params.phone);
  const [updated] = await tx<UserRow[]>`
    UPDATE app.users
    SET display_name = COALESCE(${params.display_name ?? null}, display_name),
        phone = CASE WHEN ${phoneGiven}::boolean THEN ${phone}::text ELSE phone END,
        status = COALESCE(${params.status ?? null}::app.user_status, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${userId}::uuid AND school_id = ${schoolId}
    RETURNING id, school_id, email, display_name, phone, status,
              email_verified_at, last_login_at, created_at, updated_at
  `;

  if (!updated) {
    throw new HTTPException(404, { message: "User not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "users",
    targetId: userId,
    // Whether the phone changed, not the numbers: the audit trail is kept for years.
    oldValues: {
      display_name: existing.display_name,
      status: existing.status,
    },
    newValues: {
      display_name: updated.display_name,
      status: updated.status,
      ...(updated.phone !== existing.phone ? { phone_changed: true } : {}),
    },
  });

  const user = await getUser(tx, schoolId, userId);
  if (!user) {
    throw new HTTPException(404, { message: "User not found" });
  }

  return user;
}

export async function updateUserRole(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: UpdateUserRoleParams,
): Promise<UserWithRolesRow> {
  assertAssignable(params.role);
  const existing = await getUser(tx, schoolId, userId);
  if (!existing) {
    throw new HTTPException(404, { message: "User not found" });
  }
  if (!canChangeRoleOf(params.callerRoles, existing.roles)) {
    throw new HTTPException(403, {
      message: "Only a SUPER_ADMIN can change the role of a platform staff member.",
    });
  }

  await tx`
    DELETE FROM app.user_roles
    WHERE user_id = ${userId}::uuid AND school_id = ${schoolId}
  `;

  await tx`
    INSERT INTO app.user_roles (school_id, user_id, role)
    VALUES (${schoolId}, ${userId}, ${params.role}::app.user_role)
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "user_roles",
    targetId: userId,
    oldValues: {
      roles: existing.roles,
    },
    newValues: {
      roles: [params.role],
    },
  });

  const user = await getUser(tx, schoolId, userId);
  if (!user) {
    throw new HTTPException(404, { message: "User not found" });
  }

  return user;
}

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

/**
 * The status half of deactivation, in the caller's transaction and the armed tenant: suspends the
 * user and revokes their pending invitations. Returns how many invitations were revoked. Throws 404
 * when the user does not exist in the tenant or is already suspended. Writes no audit row and
 * revokes no session -- the caller does both, since who the actor is differs between callers.
 */
export async function suspendUserInTx(tx: TransactionSql, targetUserId: string): Promise<number> {
  const [updated] = await tx<{ id: string }[]>`
    UPDATE app.users
    SET status = 'suspended'::app.user_status,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${targetUserId}::uuid
      AND school_id = current_setting('app.school_id')::uuid
      AND status != 'suspended'::app.user_status
    RETURNING id
  `;

  if (!updated) {
    throw new HTTPException(404, { message: "User not found or already suspended" });
  }

  const inviteResult = await tx`
    UPDATE app.invitations
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE school_id = current_setting('app.school_id')::uuid
      AND normalized_email = (
        SELECT normalized_email FROM app.users
        WHERE id = ${targetUserId}::uuid AND school_id = current_setting('app.school_id')::uuid
      )
      AND revoked_at IS NULL
      AND consumed_at IS NULL
  `;

  return inviteResult.count;
}

/**
 * Deactivate a user: set status to suspended, revoke all sessions, and revoke pending invitations.
 *
 * The session revocation is handled by adminRevokeUserSessions (which opens its own transaction)
 * because the SECURITY DEFINER function is needed to bypass refresh_tokens_owner RLS.
 * The status update and invitation revocation happen in a separate transaction.
 */
export async function deactivateUser(params: DeactivateUserParams): Promise<DeactivateUserResult> {
  const { database, denylist, tenant, targetUserId, log, userAgent, clientIp } = params;

  // 1. Update status + revoke invitations + emit audit (one transaction)
  const invitationsRevoked = await withTenantTx(database, tenant, async (tx) => {
    const revokedCount = await suspendUserInTx(tx, targetUserId);

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "users",
      targetId: targetUserId,
      oldValues: { status: "active" },
      newValues: { status: "suspended" },
    });

    return revokedCount;
  });

  // 2. Revoke all sessions + denylist access tokens (separate transaction via SECURITY DEFINER)
  const revocationResult = await adminRevokeUserSessions({
    database,
    denylist,
    tenant,
    targetUserId,
    reason: REVOCATION_REASONS.ADMIN_REVOKE_ALL_DEVICES,
    log,
    userAgent,
    clientIp,
  });

  log?.info(
    {
      event: "user_deactivated",
      target_user_id: targetUserId,
      revoked_token_count: revocationResult.revokedTokens,
      denylisted_jti_count: revocationResult.denylistedJtis,
      invitations_revoked: invitationsRevoked,
    },
    "user deactivated — sessions revoked, invitations revoked",
  );

  return {
    status: "suspended",
    revoked: revocationResult.revokedTokens,
    denylisted: revocationResult.denylistedJtis,
    invitations_revoked: invitationsRevoked,
  };
}
