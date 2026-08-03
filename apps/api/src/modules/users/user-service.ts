import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../db/tenant-tx";
import { decodeKeysetCursor, encodeKeysetCursor } from "../../lib/keyset-cursor";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { adminRevokeUserSessions, REVOCATION_REASONS } from "../auth/services/revocation-service";

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
  email: string;
  display_name: string | null;
  status: UserStatus;
  email_verified_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserWithRolesRow extends UserRow {
  roles: Role[];
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
  email: string;
  display_name?: string;
  role: Role;
}

export interface UpdateUserParams {
  display_name?: string;
  status?: UserStatus;
}

export interface UpdateUserRoleParams {
  role: Role;
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

export async function listUsers(
  tx: TransactionSql,
  schoolId: string,
  params: ListUsersParams,
): Promise<{ rows: UserWithRolesRow[]; next_cursor: string | null }> {
  const statusFilter = params.status ? tx` AND u.status = ${params.status}::app.user_status` : tx``;

  const searchFilter = params.search
    ? tx` AND (u.display_name ILIKE ${`%${params.search}%`} OR u.email ILIKE ${`%${params.search}%`})`
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

  const rows = await tx<UserWithRolesRow[]>`
    SELECT u.id, u.school_id, u.email, u.display_name, u.status,
           u.email_verified_at, u.last_login_at, u.created_at, u.updated_at,
           COALESCE(
             ARRAY_AGG(ur.role ORDER BY ur.created_at) FILTER (WHERE ur.role IS NOT NULL),
             '{}'
           ) AS roles
    FROM app.users u
    LEFT JOIN app.user_roles ur ON ur.user_id = u.id AND ur.school_id = u.school_id
    WHERE u.school_id = ${schoolId}
      ${statusFilter}
      ${searchFilter}
      ${createdFromFilter}
      ${createdToFilter}
      ${roleFilter}
      ${cursorFilter}
    GROUP BY u.id, u.school_id, u.email, u.display_name, u.status,
             u.email_verified_at, u.last_login_at, u.created_at, u.updated_at
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT ${limit}
  `;

  const hasMore = rows.length > limit;
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
    })),
    next_cursor,
  };
}

export async function getUser(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
): Promise<UserWithRolesRow | undefined> {
  const [row] = await tx<UserWithRolesRow[]>`
    SELECT u.id, u.school_id, u.email, u.display_name, u.status,
           u.email_verified_at, u.last_login_at, u.created_at, u.updated_at,
           COALESCE(
             ARRAY_AGG(ur.role ORDER BY ur.created_at) FILTER (WHERE ur.role IS NOT NULL),
             '{}'
           ) AS roles
    FROM app.users u
    LEFT JOIN app.user_roles ur ON ur.user_id = u.id AND ur.school_id = u.school_id
    WHERE u.id = ${userId}::uuid AND u.school_id = ${schoolId}
    GROUP BY u.id, u.school_id, u.email, u.display_name, u.status,
             u.email_verified_at, u.last_login_at, u.created_at, u.updated_at
  `;
  if (!row) return undefined;
  return {
    ...row,
    status: row.status as UserStatus,
    roles: (row.roles ?? []) as Role[],
  };
}

export async function createUser(
  tx: TransactionSql,
  schoolId: string,
  params: CreateUserParams,
): Promise<UserWithRolesRow> {
  const normalizedEmail = params.email.toLowerCase().trim();

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
    VALUES (
      ${schoolId},
      ${params.email},
      ${normalizedEmail},
      ${params.display_name ?? null},
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
      email: params.email,
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

  const [updated] = await tx<UserRow[]>`
    UPDATE app.users
    SET display_name = COALESCE(${params.display_name ?? null}, display_name),
        status = COALESCE(${params.status ?? null}::app.user_status, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${userId}::uuid AND school_id = ${schoolId}
    RETURNING id, school_id, email, display_name, status,
              email_verified_at, last_login_at, created_at, updated_at
  `;

  if (!updated) {
    throw new HTTPException(404, { message: "User not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "users",
    targetId: userId,
    oldValues: {
      display_name: existing.display_name,
      status: existing.status,
    },
    newValues: {
      display_name: updated.display_name,
      status: updated.status,
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
  const existing = await getUser(tx, schoolId, userId);
  if (!existing) {
    throw new HTTPException(404, { message: "User not found" });
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

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "users",
      targetId: targetUserId,
      oldValues: { status: "active" },
      newValues: { status: "suspended" },
    });

    return inviteResult.count;
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
