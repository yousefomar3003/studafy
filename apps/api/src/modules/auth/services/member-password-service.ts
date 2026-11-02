/**
 * Member-code + password sign-in (migration 000141) for students, parents, teachers and attendance
 * officers, who are signed up without email addresses.
 *
 * Username: the member code (STU/TCH/PAR/ATT-<school number><sequence>, 000140).
 * Password: starts as DEFAULT_MEMBER_PASSWORD. A member still on it gets NO session: sign-in answers
 * PASSWORD_CHANGE_REQUIRED until the same request also carries `newPassword`, which is stored before
 * tokens are issued. The rule is enforced here, not by the client, because the default is shared and
 * codes are sequential — a session on the default password would make every unchanged account open
 * to anyone who can count.
 *
 * Accounts holding a privileged role (school leadership, platform staff) never sign in this way;
 * they keep Google / Microsoft. Five wrong passwords lock the account for fifteen minutes. Unknown
 * codes, ineligible accounts and wrong passwords are one indistinguishable INVALID_CREDENTIALS, and
 * each path pays for one argon2 verification so timing does not tell them apart.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { ROLES } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { isLoginPermitted } from "../school-access";

import { issueTokenPair } from "./session-service";

import type { DeviceContext, IssuedTokenPair, SessionTokenConfig } from "./session-service";
import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthChannel } from "../channels";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

/** Every member's starting password, and what an admin reset returns them to. */
export const DEFAULT_MEMBER_PASSWORD = "pass@1234";

/** Roles that sign in with a member code and password. */
export const MEMBER_PASSWORD_ROLES: readonly Role[] = [
  ROLES.STUDENT,
  ROLES.PARENT,
  ROLES.INSTRUCTOR,
  ROLES.ATTENDANCE_OFFICER,
];

/** Holding any of these keeps an account on Google / Microsoft sign-in only. */
const PRIVILEGED_ROLES: readonly Role[] = [
  ROLES.SUPER_ADMIN,
  ROLES.ORG_ADMIN,
  ROLES.PRINCIPAL,
  ROLES.FINANCE,
  ROLES.SUPPORT_AGENT,
];

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Constant-time comparison with the default; both sides hashed so lengths do not leak. */
function isDefaultPassword(password: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(password), digest(DEFAULT_MEMBER_PASSWORD));
}

export type PasswordPolicyViolation = "TOO_SHORT" | "TOO_LONG" | "IS_DEFAULT" | "SAME_AS_USERNAME";

/** Null when acceptable; otherwise why not. */
export function checkNewPassword(
  password: string,
  username: string,
): PasswordPolicyViolation | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "TOO_SHORT";
  if (password.length > PASSWORD_MAX_LENGTH) return "TOO_LONG";
  if (isDefaultPassword(password)) return "IS_DEFAULT";
  if (password.trim().toUpperCase() === username.trim().toUpperCase()) return "SAME_AS_USERNAME";
  return null;
}

export function hashMemberPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** A real argon2id hash, verified against on paths with nothing to verify so they cost the same. */
let dummyHash: Promise<string> | undefined;
function burnVerification(password: string): Promise<boolean> {
  dummyHash ??= hashMemberPassword("studafy-timing-equalizer");
  return dummyHash.then((hash) => Bun.password.verify(password, hash));
}

interface CredentialRow {
  password_hash: string | null;
  failed_attempts: number;
  locked: boolean;
}

/**
 * Verifies `password` for the user in the armed tenant, updating the lockout counters. The caller's
 * transaction must commit even on a wrong password so the failure is counted.
 */
async function verifyStoredPassword(
  tx: TransactionSql,
  userId: string,
  password: string,
): Promise<"OK_DEFAULT" | "OK" | "WRONG" | "LOCKED"> {
  const [row] = await tx<CredentialRow[]>`
    SELECT password_hash, failed_attempts,
           coalesce(locked_until > CURRENT_TIMESTAMP, false) AS locked
    FROM app.member_credentials
    WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
    FOR UPDATE
  `;
  if (row?.locked) {
    await burnVerification(password);
    return "LOCKED";
  }

  const hash = row?.password_hash ?? null;
  const matches =
    hash === null
      ? (await burnVerification(password), isDefaultPassword(password))
      : await Bun.password.verify(password, hash);

  if (!matches) {
    const attempts = (row?.failed_attempts ?? 0) + 1;
    const lock = attempts >= MAX_FAILED_ATTEMPTS;
    await tx`
      INSERT INTO app.member_credentials (school_id, user_id, failed_attempts, locked_until)
      VALUES (
        current_setting('app.school_id')::uuid, ${userId}::uuid,
        ${lock ? 0 : attempts},
        ${lock ? tx`CURRENT_TIMESTAMP + make_interval(mins => ${LOCKOUT_MINUTES})` : null}
      )
      ON CONFLICT (school_id, user_id) DO UPDATE SET
        failed_attempts = EXCLUDED.failed_attempts,
        locked_until = EXCLUDED.locked_until,
        updated_at = CURRENT_TIMESTAMP
    `;
    return lock ? "LOCKED" : "WRONG";
  }

  if (row && row.failed_attempts > 0) {
    await tx`
      UPDATE app.member_credentials
      SET failed_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
    `;
  }
  return hash === null ? "OK_DEFAULT" : "OK";
}

async function storePassword(tx: TransactionSql, userId: string, password: string): Promise<void> {
  const hash = await hashMemberPassword(password);
  await tx`
    INSERT INTO app.member_credentials (school_id, user_id, password_hash, password_changed_at)
    VALUES (current_setting('app.school_id')::uuid, ${userId}::uuid, ${hash}, CURRENT_TIMESTAMP)
    ON CONFLICT (school_id, user_id) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      password_changed_at = EXCLUDED.password_changed_at,
      failed_attempts = 0,
      locked_until = NULL,
      updated_at = CURRENT_TIMESTAMP
  `;
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export interface MemberLoginParams {
  username: string;
  password: string;
  /** Required when the account is still on the default password. */
  newPassword?: string;
  channel: AuthChannel;
  device?: DeviceContext;
  requestId?: string;
  logger?: Logger;
  clientIp?: string | null;
  userAgent?: string | null;
}

export type MemberLoginResult =
  | { outcome: "LOGIN_SUCCESS"; tokens: IssuedTokenPair }
  | { outcome: "INVALID_CREDENTIALS" }
  | { outcome: "LOCKED" }
  | { outcome: "PASSWORD_CHANGE_REQUIRED" }
  | { outcome: "PASSWORD_REJECTED"; reason: PasswordPolicyViolation }
  | { outcome: "SCHOOL_SUSPENDED" };

async function resolveMemberCode(
  db: Database,
  code: string,
): Promise<{ userId: string; schoolId: string } | undefined> {
  let row: { found: boolean; userId: string; schoolId: string } | undefined;
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    [row] = await tx<{ found: boolean; userId: string; schoolId: string }[]>`
      SELECT found, user_id AS "userId", school_id AS "schoolId"
      FROM app.resolve_member_code_for_login(${code})
    `;
  });
  return row?.found && row.userId !== NIL_UUID ? row : undefined;
}

/**
 * Whether the user is a member-password account in the armed tenant: holds a member code and a
 * member-password role, and no role that keeps an account on Google / Microsoft sign-in (the same
 * eligibility loginMember applies). Account deletion asks these accounts to re-enter both.
 */
export async function isMemberPasswordAccount(
  tx: TransactionSql,
  userId: string,
): Promise<boolean> {
  const [row] = await tx<{ has_code: boolean; roles: Role[] }[]>`
    SELECT EXISTS (
             SELECT 1 FROM app.member_codes
             WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
           ) AS has_code,
           ARRAY(
             SELECT role FROM app.user_roles
             WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
           ) AS roles
  `;
  if (!row?.has_code) return false;
  return (
    row.roles.some((role) => MEMBER_PASSWORD_ROLES.includes(role)) &&
    !row.roles.some((role) => PRIVILEGED_ROLES.includes(role))
  );
}

/**
 * Re-authenticates a member-password account for a destructive action: `memberId` must be one of
 * the user's own member codes and `password` their current password. A wrong password counts
 * toward the sign-in lockout, so the caller's transaction must commit on "WRONG" as well.
 */
export async function verifyMemberCredentials(
  tx: TransactionSql,
  userId: string,
  memberId: string,
  password: string,
): Promise<"OK" | "WRONG" | "LOCKED"> {
  const codes = await tx<{ code: string }[]>`
    SELECT code FROM app.member_codes
    WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
  `;
  const ownsCode = codes.some((row) => row.code === memberId.trim().toUpperCase());
  // Verified even when the code is wrong, so both mistakes take the same time and count the same.
  const outcome = await verifyStoredPassword(tx, userId, password);
  if (outcome === "LOCKED") return "LOCKED";
  return ownsCode && outcome !== "WRONG" ? "OK" : "WRONG";
}

export async function loginMember(
  db: Database,
  config: SessionTokenConfig,
  params: MemberLoginParams,
): Promise<MemberLoginResult> {
  const username = params.username.trim().toUpperCase();
  const member = await resolveMemberCode(db, username);
  if (!member) {
    await burnVerification(params.password);
    return { outcome: "INVALID_CREDENTIALS" };
  }

  const tenant = { schoolId: member.schoolId, userId: member.userId, requestId: params.requestId };
  const audit = (tx: TransactionSql, outcome: string, targetId: string = member.userId) =>
    emitAuditLog(tx, {
      action: "login",
      targetTable: "member_credentials",
      targetId,
      newValues: { outcome, method: "member_password" },
      clientIp: params.clientIp,
      userAgent: params.userAgent,
    });

  return withTenantTx(db, tenant, async (tx): Promise<MemberLoginResult> => {
    const [account] = await tx<{ status: string; school_status: string; roles: Role[] }[]>`
      SELECT u.status::text AS status, s.status::text AS school_status,
             ARRAY(SELECT r.role FROM app.user_roles r
                   WHERE r.user_id = u.id AND r.school_id = u.school_id ORDER BY r.role) AS roles
      FROM app.users u
      JOIN app.schools s ON s.id = u.school_id
      WHERE u.id = ${member.userId}::uuid AND u.school_id = current_setting('app.school_id')::uuid
    `;
    const roles = account?.roles ?? [];
    const eligible =
      account !== undefined &&
      (account.status === "active" || account.status === "invited") &&
      roles.some((role) => MEMBER_PASSWORD_ROLES.includes(role)) &&
      !roles.some((role) => PRIVILEGED_ROLES.includes(role));
    if (!eligible) {
      await burnVerification(params.password);
      return { outcome: "INVALID_CREDENTIALS" };
    }

    const verdict = await verifyStoredPassword(tx, member.userId, params.password);
    if (verdict === "WRONG" || verdict === "LOCKED") {
      await audit(tx, verdict === "LOCKED" ? "LOGIN_FAILED_LOCKED" : "LOGIN_FAILED_PASSWORD");
      return { outcome: verdict === "LOCKED" ? "LOCKED" : "INVALID_CREDENTIALS" };
    }

    if (!isLoginPermitted(account.school_status, roles)) {
      await audit(tx, "LOGIN_FAILED_SCHOOL_SUSPENDED");
      return { outcome: "SCHOOL_SUSPENDED" };
    }

    if (verdict === "OK_DEFAULT") {
      if (params.newPassword === undefined) return { outcome: "PASSWORD_CHANGE_REQUIRED" };
      const violation = checkNewPassword(params.newPassword, username);
      if (violation) return { outcome: "PASSWORD_REJECTED", reason: violation };
      await storePassword(tx, member.userId, params.newPassword);
    }

    await tx`
      UPDATE app.users
      SET last_login_at = CURRENT_TIMESTAMP,
          status = CASE WHEN status = 'invited' THEN 'active'::app.user_status ELSE status END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${member.userId}::uuid AND school_id = current_setting('app.school_id')::uuid
    `;
    const tokens = await issueTokenPair(tx, config, {
      userId: member.userId,
      schoolId: member.schoolId,
      channel: params.channel,
      device: params.device,
    });
    await audit(
      tx,
      verdict === "OK_DEFAULT" ? "LOGIN_SUCCESS_PASSWORD_SET" : "LOGIN_SUCCESS",
      tokens.sessionId,
    );
    params.logger?.info(
      { user_id: member.userId, school_id: member.schoolId, session_id: tokens.sessionId },
      "member password login successful",
    );
    return { outcome: "LOGIN_SUCCESS", tokens };
  });
}

// ---------------------------------------------------------------------------
// Change (signed in) and reset (admin)
// ---------------------------------------------------------------------------

export type ChangePasswordResult =
  | { outcome: "CHANGED" }
  | { outcome: "WRONG_PASSWORD" }
  | { outcome: "LOCKED" }
  | { outcome: "NOT_ELIGIBLE" }
  | { outcome: "PASSWORD_REJECTED"; reason: PasswordPolicyViolation };

/** The signed-in member replaces their own password, proving the current one first. */
export async function changeMemberPassword(
  db: Database,
  tenant: { schoolId: string; userId: string; requestId?: string },
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  return withTenantTx(db, tenant, async (tx): Promise<ChangePasswordResult> => {
    const codes = await tx<{ code: string }[]>`
      SELECT code FROM app.member_codes
      WHERE user_id = ${tenant.userId}::uuid AND school_id = current_setting('app.school_id')::uuid
      ORDER BY kind
    `;
    if (codes.length === 0) return { outcome: "NOT_ELIGIBLE" };

    const verdict = await verifyStoredPassword(tx, tenant.userId, currentPassword);
    if (verdict === "WRONG") return { outcome: "WRONG_PASSWORD" };
    if (verdict === "LOCKED") return { outcome: "LOCKED" };

    for (const { code } of codes) {
      const violation = checkNewPassword(newPassword, code);
      if (violation) return { outcome: "PASSWORD_REJECTED", reason: violation };
    }
    await storePassword(tx, tenant.userId, newPassword);
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "member_credentials",
      targetId: tenant.userId,
      oldValues: { password_default: verdict === "OK_DEFAULT" },
      newValues: { event: "password_changed", password_default: false },
    });
    return { outcome: "CHANGED" };
  });
}

/**
 * Returns the member to the default password (forcing a change at next sign-in) and clears any
 * lockout. Runs in the administrator's tenant transaction. Undefined when the user has no member
 * code, i.e. is not someone who signs in with a password.
 */
export async function resetMemberPassword(
  tx: TransactionSql,
  userId: string,
): Promise<{ usernames: string[] } | undefined> {
  const codes = await tx<{ code: string }[]>`
    SELECT code FROM app.member_codes
    WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
    ORDER BY kind
  `;
  if (codes.length === 0) return undefined;
  const [before] = await tx<{ was_default: boolean }[]>`
    SELECT password_hash IS NULL AS was_default FROM app.member_credentials
    WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
  `;
  await tx`
    INSERT INTO app.member_credentials (school_id, user_id)
    VALUES (current_setting('app.school_id')::uuid, ${userId}::uuid)
    ON CONFLICT (school_id, user_id) DO UPDATE SET
      password_hash = NULL,
      password_changed_at = NULL,
      failed_attempts = 0,
      locked_until = NULL,
      updated_at = CURRENT_TIMESTAMP
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "member_credentials",
    targetId: userId,
    oldValues: { password_default: before?.was_default ?? true },
    newValues: { event: "password_reset_to_default", password_default: true },
  });
  return { usernames: codes.map((row) => row.code) };
}
