/**
 * Member-code + password sign-in (migration 000141) for students, parents, teachers and attendance
 * officers, who are signed up without email addresses.
 *
 * Username: the member code (STU/TCH/PAR/ATT-<school number><sequence>, 000140).
 * Password: none until the member claims the account with a setup code (000184) — a random,
 * per-member, one-time secret an administrator issues, valid for SETUP_CODE_TTL_DAYS. A setup code
 * gets NO session: sign-in answers PASSWORD_CHANGE_REQUIRED until the same request also carries
 * `newPassword`, which is stored (consuming the code) before tokens are issued. Codes are sequential,
 * so nothing a stranger could know or guess — such as a shared default password — may ever open an
 * account.
 *
 * Accounts holding a privileged role (school leadership, platform staff) never sign in this way;
 * they keep Google / Microsoft. Five wrong passwords lock the account for fifteen minutes -- except
 * against a device that has already signed in to it (000186), which keeps its own count instead, so
 * a stranger who knows the ID cannot lock its owner out (see TRUSTED DEVICES below). Unknown
 * codes, ineligible accounts and wrong passwords are one indistinguishable INVALID_CREDENTIALS, and
 * each path pays for one argon2 verification so timing does not tell them apart.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { ROLES } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { AUTH_CHANNELS } from "../channels";
import { isLoginPermitted } from "../school-access";

import { isCommonPassword } from "./password-blocklist";
import { issueTokenPair } from "./session-service";

import type { DeviceContext, IssuedTokenPair, SessionTokenConfig } from "./session-service";
import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthChannel } from "../channels";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

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

// ---------------------------------------------------------------------------
// Trusted devices (000186)
// ---------------------------------------------------------------------------
//
// A device that signs in successfully on a non-web channel receives a random device token
// (app.member_trusted_devices). When it presents that token again with the password, the attempt is
// judged on the device's own record: the account-wide lockout and the per-member-ID budget, which
// anyone who knows the ID can exhaust, do not apply; TRUSTED_DEVICE_MAX_FAILURES wrong passwords in
// a row delete the device instead. Only the token's SHA-256 is stored -- it is 256 random bits, so it
// needs no slow hash.

/** Wrong passwords in a row after which a device is no longer trusted. */
export const TRUSTED_DEVICE_MAX_FAILURES = 5;
/** Devices kept per member; the least recently used beyond this are deleted. */
export const TRUSTED_DEVICES_PER_MEMBER = 10;

export function generateDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Whether `deviceToken` is one of the member's trusted devices. Read before the sign-in budgets are
 * spent, to decide which budgets apply; loginMember checks again under a row lock.
 */
export async function isTrustedMemberDevice(
  db: Database,
  username: string,
  deviceToken: string,
): Promise<boolean> {
  const member = await resolveMemberCode(db, username.trim().toUpperCase());
  if (!member) return false;
  const tenant = { schoolId: member.schoolId, userId: member.userId };
  return withTenantTx(db, tenant, async (tx) => {
    const rows = await tx<{ found: number }[]>`
      SELECT 1 AS found FROM app.member_trusted_devices
      WHERE school_id = current_setting('app.school_id')::uuid
        AND user_id = ${member.userId}::uuid
        AND token_hash = ${hashDeviceToken(deviceToken)}
    `;
    return rows.length > 0;
  });
}

/** The trusted device row for `deviceHash`, locked for this transaction; undefined if none. */
async function lockTrustedDevice(
  tx: TransactionSql,
  userId: string,
  deviceHash: string,
): Promise<{ failed_attempts: number } | undefined> {
  const [row] = await tx<{ failed_attempts: number }[]>`
    SELECT failed_attempts FROM app.member_trusted_devices
    WHERE school_id = current_setting('app.school_id')::uuid
      AND user_id = ${userId}::uuid
      AND token_hash = ${deviceHash}
    FOR UPDATE
  `;
  return row;
}

// ---------------------------------------------------------------------------
// Setup codes
// ---------------------------------------------------------------------------

export const SETUP_CODE_TTL_DAYS = 14;

/** Crockford base32: 32 symbols, so each is exactly 5 random bits, and no I, L, O or U to misread. */
const SETUP_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 16 symbols × 5 bits = 80 bits, printed as XXXX-XXXX-XXXX-XXXX. */
const SETUP_CODE_LENGTH = 16;

export function generateSetupCode(): string {
  const symbols = Array.from(randomBytes(SETUP_CODE_LENGTH), (byte) =>
    SETUP_CODE_ALPHABET.charAt(byte & 31),
  ).join("");
  return symbols.match(/.{4}/g)!.join("-");
}

/**
 * The canonical form a setup code is hashed in: case, spaces and dashes ignored, and the letters
 * people type for the digits they resemble read as those digits.
 */
export function normalizeSetupCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

function hashSetupCode(code: string): string {
  return createHash("sha256").update(normalizeSetupCode(code), "utf8").digest("hex");
}

function setupCodeMatches(input: string, storedHash: string): boolean {
  return timingSafeEqual(Buffer.from(hashSetupCode(input), "hex"), Buffer.from(storedHash, "hex"));
}

export type PasswordPolicyViolation =
  "TOO_SHORT" | "TOO_LONG" | "IS_SETUP_CODE" | "SAME_AS_USERNAME" | "TOO_COMMON";

/** Null when acceptable; otherwise why not. */
export function checkNewPassword(
  password: string,
  username: string,
): PasswordPolicyViolation | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "TOO_SHORT";
  if (password.length > PASSWORD_MAX_LENGTH) return "TOO_LONG";
  const normalizedId = username.trim().toUpperCase();
  const normalized = password.trim().toUpperCase();
  if (normalized === normalizedId) return "SAME_AS_USERNAME";
  // The ID is public (sequential and printed on sheets), so a password built on it -- or on its
  // number alone -- is one of the first guesses against that account.
  const idNumber = normalizedId.replace(/^[A-Z]+-/u, "");
  if (idNumber.length >= 4 && normalized.includes(idNumber)) return "SAME_AS_USERNAME";
  if (isCommonPassword(password)) return "TOO_COMMON";
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
  /** Null when there is no setup code or it has expired. */
  live_setup_code_hash: string | null;
  failed_attempts: number;
  locked: boolean;
}

/**
 * Verifies `password` for the user in the armed tenant, updating the lockout counters: against the
 * stored password, or — for an account with none yet — against its unexpired setup code ("OK_SETUP").
 * An account with neither matches nothing. The caller's transaction must commit even on a wrong
 * password so the failure is counted.
 *
 * With `deviceHash` naming one of the member's trusted devices, the account lockout is neither
 * checked nor advanced: a wrong password counts against that device, which is dropped after
 * TRUSTED_DEVICE_MAX_FAILURES in a row.
 */
async function verifyStoredPassword(
  tx: TransactionSql,
  userId: string,
  password: string,
  deviceHash?: string,
): Promise<"OK_SETUP" | "OK" | "WRONG" | "LOCKED"> {
  const [row] = await tx<CredentialRow[]>`
    SELECT password_hash, failed_attempts,
           CASE WHEN setup_code_expires_at > CURRENT_TIMESTAMP THEN setup_code_hash END
             AS live_setup_code_hash,
           coalesce(locked_until > CURRENT_TIMESTAMP, false) AS locked
    FROM app.member_credentials
    WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
    FOR UPDATE
  `;
  const device =
    deviceHash === undefined ? undefined : await lockTrustedDevice(tx, userId, deviceHash);
  if (row?.locked && !device) {
    await burnVerification(password);
    return "LOCKED";
  }

  const hash = row?.password_hash ?? null;
  const setupHash = row?.live_setup_code_hash ?? null;
  // Every branch pays for one argon2 verification so timing does not reveal which one ran.
  const matches =
    hash === null
      ? (await burnVerification(password),
        setupHash !== null && setupCodeMatches(password, setupHash))
      : await Bun.password.verify(password, hash);

  if (!matches && device) {
    if (device.failed_attempts + 1 >= TRUSTED_DEVICE_MAX_FAILURES) {
      await tx`
        DELETE FROM app.member_trusted_devices
        WHERE school_id = current_setting('app.school_id')::uuid
          AND user_id = ${userId}::uuid AND token_hash = ${deviceHash!}
      `;
    } else {
      await tx`
        UPDATE app.member_trusted_devices
        SET failed_attempts = failed_attempts + 1, updated_at = CURRENT_TIMESTAMP
        WHERE school_id = current_setting('app.school_id')::uuid
          AND user_id = ${userId}::uuid AND token_hash = ${deviceHash!}
      `;
    }
    return "WRONG";
  }

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

  if (device) {
    await tx`
      UPDATE app.member_trusted_devices
      SET failed_attempts = 0, updated_at = CURRENT_TIMESTAMP
      WHERE school_id = current_setting('app.school_id')::uuid
        AND user_id = ${userId}::uuid AND token_hash = ${deviceHash!}
    `;
  }
  if (row && (row.failed_attempts > 0 || row.locked)) {
    await tx`
      UPDATE app.member_credentials
      SET failed_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
    `;
  }
  return hash === null ? "OK_SETUP" : "OK";
}

/** Stores the member's password, consuming any setup code. */
async function storePassword(tx: TransactionSql, userId: string, password: string): Promise<void> {
  const hash = await hashMemberPassword(password);
  await tx`
    INSERT INTO app.member_credentials (school_id, user_id, password_hash, password_changed_at)
    VALUES (current_setting('app.school_id')::uuid, ${userId}::uuid, ${hash}, CURRENT_TIMESTAMP)
    ON CONFLICT (school_id, user_id) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      password_changed_at = EXCLUDED.password_changed_at,
      setup_code_hash = NULL,
      setup_code_expires_at = NULL,
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
  /** The member's password, or their setup code while they have none. */
  password: string;
  /** Required when `password` is a setup code. */
  newPassword?: string;
  /** The device token this device was given at an earlier sign-in, if any. */
  deviceToken?: string;
  channel: AuthChannel;
  device?: DeviceContext;
  requestId?: string;
  logger?: Logger;
  clientIp?: string | null;
  userAgent?: string | null;
}

export type MemberLoginResult =
  | {
      outcome: "LOGIN_SUCCESS";
      tokens: IssuedTokenPair;
      /** For a non-web channel: the token that marks this device as trusted from now on. */
      deviceToken?: string;
    }
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
 * the user's own member codes and `password` their current password (a setup code is not one). A
 * wrong password counts toward the sign-in lockout, so the caller's transaction must commit on
 * "WRONG" as well.
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
  return ownsCode && outcome === "OK" ? "OK" : "WRONG";
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

    const deviceHash =
      params.deviceToken === undefined ? undefined : hashDeviceToken(params.deviceToken);
    const verdict = await verifyStoredPassword(tx, member.userId, params.password, deviceHash);
    if (verdict === "WRONG" || verdict === "LOCKED") {
      await audit(tx, verdict === "LOCKED" ? "LOGIN_FAILED_LOCKED" : "LOGIN_FAILED_PASSWORD");
      return { outcome: verdict === "LOCKED" ? "LOCKED" : "INVALID_CREDENTIALS" };
    }

    if (!isLoginPermitted(account.school_status, roles)) {
      await audit(tx, "LOGIN_FAILED_SCHOOL_SUSPENDED");
      return { outcome: "SCHOOL_SUSPENDED" };
    }

    if (verdict === "OK_SETUP") {
      if (params.newPassword === undefined) return { outcome: "PASSWORD_CHANGE_REQUIRED" };
      const violation =
        checkNewPassword(params.newPassword, username) ??
        (normalizeSetupCode(params.newPassword) === normalizeSetupCode(params.password)
          ? "IS_SETUP_CODE"
          : null);
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
    // A browser gets no device token: it would have to live where page script can read it.
    const deviceToken =
      params.channel === AUTH_CHANNELS.WEB
        ? undefined
        : await trustDevice(tx, member.userId, deviceHash);
    await audit(
      tx,
      verdict === "OK_SETUP" ? "LOGIN_SUCCESS_PASSWORD_SET" : "LOGIN_SUCCESS",
      tokens.sessionId,
    );
    params.logger?.info(
      { user_id: member.userId, school_id: member.schoolId, session_id: tokens.sessionId },
      "member password login successful",
    );
    return { outcome: "LOGIN_SUCCESS", tokens, deviceToken };
  });
}

/**
 * After a successful sign-in, makes sure this device is trusted. A device that presented a trusted
 * token keeps it (undefined: nothing new to store); any other gets a fresh one, and the member's
 * least recently used devices beyond TRUSTED_DEVICES_PER_MEMBER are deleted.
 */
async function trustDevice(
  tx: TransactionSql,
  userId: string,
  presentedHash: string | undefined,
): Promise<string | undefined> {
  if (presentedHash !== undefined && (await lockTrustedDevice(tx, userId, presentedHash))) {
    return undefined;
  }
  const token = generateDeviceToken();
  await tx`
    INSERT INTO app.member_trusted_devices (school_id, user_id, token_hash)
    VALUES (current_setting('app.school_id')::uuid, ${userId}::uuid, ${hashDeviceToken(token)})
  `;
  await tx`
    DELETE FROM app.member_trusted_devices
    WHERE school_id = current_setting('app.school_id')::uuid
      AND user_id = ${userId}::uuid
      AND token_hash NOT IN (
        SELECT token_hash FROM app.member_trusted_devices
        WHERE school_id = current_setting('app.school_id')::uuid AND user_id = ${userId}::uuid
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ${TRUSTED_DEVICES_PER_MEMBER}
      )
  `;
  return token;
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

    // A setup code is for claiming the account at sign-in, not for proving who is signed in.
    const verdict = await verifyStoredPassword(tx, tenant.userId, currentPassword);
    if (verdict === "LOCKED") return { outcome: "LOCKED" };
    if (verdict !== "OK") return { outcome: "WRONG_PASSWORD" };

    for (const { code } of codes) {
      const violation = checkNewPassword(newPassword, code);
      if (violation) return { outcome: "PASSWORD_REJECTED", reason: violation };
    }
    await storePassword(tx, tenant.userId, newPassword);
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "member_credentials",
      targetId: tenant.userId,
      oldValues: { had_password: true },
      newValues: { event: "password_changed", had_password: true },
    });
    return { outcome: "CHANGED" };
  });
}

export interface IssuedSetupCode {
  /** The member IDs they sign in with. */
  usernames: string[];
  /** Plaintext, returned to the issuing administrator only; never stored or retrievable again. */
  setupCode: string;
  expiresAt: Date;
}

/**
 * Removes the member's password and clears any lockout, replacing both with a fresh setup code, so
 * the next sign-in must choose a new password. Any earlier setup code stops working. The caller
 * signs the member out everywhere.
 */
async function writeSetupCode(
  tx: TransactionSql,
  userId: string,
): Promise<{ setupCode: string; expiresAt: Date }> {
  const setupCode = generateSetupCode();
  const [before] = await tx<{ had_password: boolean }[]>`
    SELECT password_hash IS NOT NULL AS had_password FROM app.member_credentials
    WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
  `;
  const [row] = await tx<{ expires_at: Date }[]>`
    INSERT INTO app.member_credentials (school_id, user_id, setup_code_hash, setup_code_expires_at)
    VALUES (
      current_setting('app.school_id')::uuid, ${userId}::uuid, ${hashSetupCode(setupCode)},
      CURRENT_TIMESTAMP + make_interval(days => ${SETUP_CODE_TTL_DAYS})
    )
    ON CONFLICT (school_id, user_id) DO UPDATE SET
      password_hash = NULL,
      password_changed_at = NULL,
      setup_code_hash = EXCLUDED.setup_code_hash,
      setup_code_expires_at = EXCLUDED.setup_code_expires_at,
      failed_attempts = 0,
      locked_until = NULL,
      updated_at = CURRENT_TIMESTAMP
    RETURNING setup_code_expires_at AS expires_at
  `;
  // A reset is how an account is taken back; no device keeps a way around its lockout.
  await tx`
    DELETE FROM app.member_trusted_devices
    WHERE school_id = current_setting('app.school_id')::uuid AND user_id = ${userId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "member_credentials",
    targetId: userId,
    oldValues: { had_password: before?.had_password ?? false },
    newValues: { event: "setup_code_issued", expires_at: row!.expires_at.toISOString() },
  });
  return { setupCode, expiresAt: row!.expires_at };
}

/**
 * An administrator's password reset: issues the member a new setup code (see writeSetupCode). Runs
 * in the administrator's tenant transaction. Undefined when the user has no member code, i.e. is
 * not someone who signs in with a password.
 */
export async function issueMemberSetupCode(
  tx: TransactionSql,
  userId: string,
): Promise<IssuedSetupCode | undefined> {
  const codes = await tx<{ code: string }[]>`
    SELECT code FROM app.member_codes
    WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
    ORDER BY kind
  `;
  if (codes.length === 0) return undefined;
  const { setupCode, expiresAt } = await writeSetupCode(tx, userId);
  return { usernames: codes.map((row) => row.code), setupCode, expiresAt };
}

/** Most setup codes one bulk call issues; the caller repeats until `remaining` is zero. */
export const SETUP_CODE_BATCH_LIMIT = 500;

const MEMBER_CODE_KINDS: Partial<Record<Role, string>> = {
  [ROLES.STUDENT]: "STU",
  [ROLES.INSTRUCTOR]: "TCH",
  [ROLES.PARENT]: "PAR",
  [ROLES.ATTENDANCE_OFFICER]: "ATT",
};

export interface IssuedSetupCodeBatch {
  issued: (IssuedSetupCode & { userId: string; displayName: string | null })[];
  /** Members still waiting for a code because the batch was full. */
  remaining: number;
}

/**
 * Issues setup codes to the school's members of `role` who cannot sign in yet: an active or invited
 * account that has never set a password and holds no unexpired setup code. Members who already have
 * a live code are skipped, so re-running never invalidates a sheet already handed out; a lost code
 * is replaced one member at a time with issueMemberSetupCode. This is how a school hands out first
 * sign-ins in bulk, and how accounts created under the old default password are brought back.
 */
export async function issueUnclaimedSetupCodes(
  tx: TransactionSql,
  role: Role,
): Promise<IssuedSetupCodeBatch> {
  // eslint-disable-next-line security/detect-object-injection -- `role` is a validated Role
  const kind = MEMBER_CODE_KINDS[role];
  if (!kind) return { issued: [], remaining: 0 };

  const candidates = await tx<{ user_id: string; display_name: string | null; total: number }[]>`
    SELECT u.id AS user_id, u.display_name, count(*) OVER ()::int AS total
    FROM app.users u
    JOIN app.member_codes mc ON mc.user_id = u.id AND mc.school_id = u.school_id AND mc.kind = ${kind}
    LEFT JOIN app.member_credentials cr ON cr.user_id = u.id AND cr.school_id = u.school_id
    WHERE u.school_id = current_setting('app.school_id')::uuid
      AND u.status IN ('active', 'invited')
      AND cr.password_hash IS NULL
      AND coalesce(cr.setup_code_expires_at <= CURRENT_TIMESTAMP, true)
      AND NOT EXISTS (
        SELECT 1 FROM app.user_roles r
        WHERE r.user_id = u.id AND r.school_id = u.school_id
          AND r.role::text = ANY(${[...PRIVILEGED_ROLES]}::text[])
      )
    ORDER BY mc.code
    LIMIT ${SETUP_CODE_BATCH_LIMIT}
  `;
  if (candidates.length === 0) return { issued: [], remaining: 0 };

  const codes = await tx<{ user_id: string; code: string }[]>`
    SELECT user_id, code FROM app.member_codes
    WHERE school_id = current_setting('app.school_id')::uuid
      AND user_id = ANY(${candidates.map((row) => row.user_id)}::uuid[])
    ORDER BY kind
  `;
  const issued: IssuedSetupCodeBatch["issued"] = [];
  for (const candidate of candidates) {
    const { setupCode, expiresAt } = await writeSetupCode(tx, candidate.user_id);
    issued.push({
      userId: candidate.user_id,
      displayName: candidate.display_name,
      usernames: codes.filter((row) => row.user_id === candidate.user_id).map((row) => row.code),
      setupCode,
      expiresAt,
    });
  }
  return { issued, remaining: candidates[0]!.total - issued.length };
}
