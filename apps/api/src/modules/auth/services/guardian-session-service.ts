/**
 * "Add <child> to this phone" (000215): a parent signed in on the mobile app puts a linked child's
 * own account on the family phone with one tap, instead of typing the child's long member ID and
 * password. The result is an ordinary student session -- the same token pair, lifetimes and
 * rotation family a member sign-in produces -- so everything the child does afterwards is done as
 * the child; the parent never acts as the child inside the parent's own account.
 *
 * Who may: the caller holds PARENT and has a row in app.parent_child_links for that student in this
 * school. The link row is the only thing that connects the two people: nothing is ever matched by
 * name, email, phone or ID number. Every relationship type counts, because the link is already what
 * lets the parent see the child's grades, attendance and fees in the parent app; this adds no
 * visibility the link does not already grant.
 *
 * The child's account must be one that signs in with a member ID (STUDENT, no privileged role) and
 * be in use:
 *   - users.status active or invited. "invited" -- the child never chose a password -- is allowed on
 *     purpose: the parent is exactly who the school hands a child's setup code to, and this is the
 *     path that spares the family that code. The account stays "invited", so the child can still
 *     claim it with a setup code later.
 *   - students.status applicant or enrolled. Suspended, graduated, withdrawn and archived students
 *     are refused: they are no longer (or not now) using the school's app.
 *   - not locked by too many wrong passwords. A lockout means someone has been guessing; it clears
 *     on its own after LOCKOUT_MINUTES, and a parent may also ask the school to reset it.
 *   - the school is open (isLoginPermitted) and has not switched the feature off
 *     (school_settings.allow_parent_device_signin, default on).
 *
 * The session is minted in the same transaction that checks all of this, as the child: app.user_id
 * is pointed at the child for the INSERT into refresh_tokens (its RESTRICTIVE owner policy only lets
 * a user write their own sessions, 000029), then pointed back at the parent before the audit row is
 * written, so the audit's actor is the parent who did it and its target is the new session. The
 * family is recorded in app.guardian_issued_sessions so the child's and an administrator's session
 * lists say "opened by a parent"; ending it is the ordinary session revoke.
 */

import { ROLES } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { AUTH_CHANNELS } from "../channels";
import { isLoginPermitted } from "../school-access";

import { PRIVILEGED_ROLES } from "./member-password-service";
import { issueTokenPair } from "./session-service";

import type { DeviceContext, IssuedTokenPair, SessionTokenConfig } from "./session-service";
import type { Database } from "../../../db/client";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

const ALLOWED_STUDENT_STATUSES: ReadonlySet<string> = new Set(["applicant", "enrolled"]);
const ALLOWED_USER_STATUSES: ReadonlySet<string> = new Set(["active", "invited"]);

export interface GuardianChildAccount {
  userId: string;
  displayName: string;
  schoolName: string;
  memberIds: string[];
}

export type GuardianSessionResult =
  | { outcome: "ISSUED"; tokens: IssuedTokenPair; child: GuardianChildAccount }
  /** No link between this parent and that student in this school (or no such student). */
  | { outcome: "NOT_LINKED" }
  /** The school has turned the feature off. */
  | { outcome: "DISABLED" }
  /** The child's account cannot be used now: inactive, or not a member-ID student account. */
  | { outcome: "CHILD_UNAVAILABLE" }
  /** Too many wrong passwords on the child's account. */
  | { outcome: "LOCKED" }
  /** The school is suspended or closed. */
  | { outcome: "SCHOOL_SUSPENDED" };

export interface GuardianSessionParams {
  schoolId: string;
  guardianUserId: string;
  studentId: string;
  requestId?: string;
  device?: DeviceContext;
  clientIp?: string | null;
  userAgent?: string | null;
}

interface ChildRow {
  user_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  student_status: string;
  user_status: string;
  school_status: string;
  school_name: string;
  roles: Role[];
  locked: boolean;
  allowed: boolean;
}

async function readChild(
  tx: TransactionSql,
  guardianUserId: string,
  studentId: string,
): Promise<ChildRow | undefined> {
  const [row] = await tx<ChildRow[]>`
    SELECT s.user_id::text AS user_id,
           s.first_name, s.last_name, s.preferred_name,
           s.status::text AS student_status,
           u.status::text AS user_status,
           sc.status::text AS school_status,
           sc.name AS school_name,
           ARRAY(SELECT r.role FROM app.user_roles r
                 WHERE r.user_id = s.user_id AND r.school_id = s.school_id ORDER BY r.role) AS roles,
           coalesce((SELECT mc.locked_until > CURRENT_TIMESTAMP FROM app.member_credentials mc
                     WHERE mc.user_id = s.user_id AND mc.school_id = s.school_id), false) AS locked,
           coalesce((SELECT ss.allow_parent_device_signin FROM app.school_settings ss
                     WHERE ss.school_id = s.school_id), true) AS allowed
    FROM app.parent_child_links l
    JOIN app.students s ON s.id = l.student_id AND s.school_id = l.school_id
    JOIN app.users u ON u.id = s.user_id AND u.school_id = s.school_id
    JOIN app.schools sc ON sc.id = s.school_id
    WHERE l.parent_user_id = ${guardianUserId}::uuid
      AND l.student_id = ${studentId}::uuid
      AND l.school_id = current_setting('app.school_id')::uuid
  `;
  return row;
}

function childUnavailable(row: ChildRow): boolean {
  return (
    !ALLOWED_USER_STATUSES.has(row.user_status) ||
    !ALLOWED_STUDENT_STATUSES.has(row.student_status) ||
    !row.roles.includes(ROLES.STUDENT) ||
    row.roles.some((role) => PRIVILEGED_ROLES.includes(role))
  );
}

/** Points the transaction's acting user at `userId` (transaction-local, like withTenantTx's own). */
async function actAs(tx: TransactionSql, userId: string): Promise<void> {
  await tx`SELECT set_config('app.user_id', ${userId}, true)`;
}

export async function issueGuardianChildSession(
  db: Database,
  config: SessionTokenConfig,
  params: GuardianSessionParams,
): Promise<GuardianSessionResult> {
  const tenant = {
    schoolId: params.schoolId,
    userId: params.guardianUserId,
    requestId: params.requestId,
  };

  return withTenantTx(db, tenant, async (tx): Promise<GuardianSessionResult> => {
    // Refusals point at the child's account, the issued session at its refresh-token row.
    const audit = (
      outcome: string,
      target: { table: "users" | "refresh_tokens"; id: string },
      extra: Record<string, unknown> = {},
    ) =>
      emitAuditLog(tx, {
        action: "login",
        targetTable: target.table,
        targetId: target.id,
        newValues: {
          outcome,
          method: "guardian_device",
          guardian_user_id: params.guardianUserId,
          student_id: params.studentId,
          ...extra,
        },
        clientIp: params.clientIp,
        userAgent: params.userAgent,
      });

    const child = await readChild(tx, params.guardianUserId, params.studentId);
    if (!child) return { outcome: "NOT_LINKED" };
    if (!child.allowed) return { outcome: "DISABLED" };
    if (childUnavailable(child)) {
      await audit("GUARDIAN_SESSION_REFUSED_INACTIVE", { table: "users", id: child.user_id });
      return { outcome: "CHILD_UNAVAILABLE" };
    }
    if (child.locked) {
      await audit("GUARDIAN_SESSION_REFUSED_LOCKED", { table: "users", id: child.user_id });
      return { outcome: "LOCKED" };
    }
    if (!isLoginPermitted(child.school_status, child.roles)) {
      return { outcome: "SCHOOL_SUSPENDED" };
    }

    // Mint as the child (refresh_tokens' owner policy), then record and audit as the parent.
    await actAs(tx, child.user_id);
    const tokens = await issueTokenPair(tx, config, {
      userId: child.user_id,
      schoolId: params.schoolId,
      channel: AUTH_CHANNELS.MOBILE,
      device: params.device,
    });
    await actAs(tx, params.guardianUserId);

    await tx`
      INSERT INTO app.guardian_issued_sessions (school_id, family_id, user_id, guardian_user_id)
      VALUES (
        current_setting('app.school_id')::uuid,
        ${tokens.familyId}::uuid,
        ${child.user_id}::uuid,
        ${params.guardianUserId}::uuid
      )
    `;
    await audit(
      "GUARDIAN_SESSION_ISSUED",
      { table: "refresh_tokens", id: tokens.sessionId },
      { student_user_id: child.user_id },
    );

    const memberIds = await tx<{ code: string }[]>`
      SELECT code FROM app.member_codes
      WHERE user_id = ${child.user_id}::uuid AND school_id = current_setting('app.school_id')::uuid
      ORDER BY code
    `;
    const displayName = `${child.preferred_name ?? child.first_name} ${child.last_name}`.trim();

    return {
      outcome: "ISSUED",
      tokens,
      child: {
        userId: child.user_id,
        displayName,
        schoolName: child.school_name,
        memberIds: memberIds.map((row) => row.code),
      },
    };
  });
}
