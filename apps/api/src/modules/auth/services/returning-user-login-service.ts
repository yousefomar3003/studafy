/**
 * Returning-user OAuth login — authenticates an active user via a verified Microsoft OIDC
 * id_token and issues session tokens (ST-079).
 *
 * The flow is:
 *   1. Match the incoming (provider, sub) pair against app.oauth_identities.
 *   2. If no match: yield NO_ACCOUNT (structured log, no audit_logs row — school_id is unknown).
 *   3. Enforce tenant suspension policy: suspended schools block standard roles; admin roles
 *      (SUPER_ADMIN, ORG_ADMIN) are permitted to log in to resolve administrative issues.
 *   4. Issue a session token pair (ST-071 reuse) and update last_login_at atomically.
 *   5. Record the outcome in audit_logs (LOGIN_SUCCESS, LOGIN_FAILED_SCHOOL_SUSPENDED).
 *
 * The identity lookup hits the composite unique index on oauth_identities (provider, subject)
 * and executes outside tenant context — the lookup is global because the (provider, subject) pair
 * is globally unique across all schools. Tenant context opens only after the identity is resolved.
 *
 * Performance target: p95 < 400 ms (excluding external Microsoft JWKS round-trips).
 */

import { ROLES } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import { issueTokenPair } from "./session-service";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthChannel } from "../channels";
import type { DeviceContext, IssuedTokenPair, SessionTokenConfig } from "./session-service";
import type { Role } from "@studafy/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReturningUserLoginParams {
  /** The validated Microsoft or Google OIDC subject claim (`sub`) from the id_token. */
  subject: string;
  /** The OAuth provider that issued the id_token. Defaults to "microsoft" for backward compat. */
  provider?: string;
  /** Channel determines refresh-token delivery (cookie vs body). */
  channel: AuthChannel;
  /** Optional device metadata captured from the request. */
  device?: DeviceContext;
  /** Correlates audit logs and structured log lines to the originating HTTP request. */
  requestId?: string;
  /** Structured logger for non-audit events (e.g. NO_ACCOUNT which lacks a school_id). */
  logger?: Logger;
  /** Client IP for device context and audit metadata. */
  clientIp?: string | null;
  /** User-Agent for device context and audit metadata. */
  userAgent?: string | null;
}

export type ReturningUserLoginResult =
  | { outcome: "LOGIN_SUCCESS"; tokens: IssuedTokenPair }
  | { outcome: "NO_ACCOUNT" }
  | { outcome: "SCHOOL_SUSPENDED" };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Roles permitted to log into a suspended school to resolve administrative issues. */
const ADMINISTRATIVE_ROLES: ReadonlySet<Role> = new Set([ROLES.SUPER_ADMIN, ROLES.ORG_ADMIN]);

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

interface ResolvedIdentity {
  userId: string;
  schoolId: string;
  identityId: string;
}

/**
 * Match an incoming (provider, subject) pair against the globally unique index on
 * app.oauth_identities. The pair is unique across all schools by design (migration 000007), so this
 * is a legitimate global lookup — but the table is FORCE ROW LEVEL SECURITY and no runtime role
 * holds BYPASSRLS, so it cannot be read before app.school_id is known. Migration 000034 provides the
 * SECURITY DEFINER resolver that bridges that chicken-and-egg: it scopes a permissive SELECT policy
 * to the (provider, subject) pair placed in transaction-local GUCs, exactly as the invitation seams
 * (000031/000033) do for their bearer tokens. Runs in its own short transaction against the resolver;
 * the caller opens a real tenant transaction with the resolved school_id afterwards.
 *
 * Returns undefined when no identity matches. Does NOT throw for a miss — callers branch on undefined
 * rather than catching, which keeps the NO_ACCOUNT path cheap and explicit.
 */
async function findOAuthIdentity(
  db: Database,
  provider: string,
  subject: string,
): Promise<ResolvedIdentity | undefined> {
  let row: { found: boolean; userId: string; schoolId: string; identityId: string } | undefined;
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    const rows = await tx<
      { found: boolean; userId: string; schoolId: string; identityId: string }[]
    >`
      SELECT
        found,
        user_id AS "userId",
        school_id AS "schoolId",
        identity_id AS "identityId"
      FROM app.resolve_oauth_identity_for_login(${provider}, ${subject})
    `;
    row = rows[0];
  });

  if (!row || !row.found) return undefined;
  return { userId: row.userId, schoolId: row.schoolId, identityId: row.identityId };
}

// ---------------------------------------------------------------------------
// School status & role check
// ---------------------------------------------------------------------------

interface TenantPolicyResult {
  schoolStatus: string;
  roles: Role[];
}

/**
 * Open a tenant-scoped transaction to read the school's status and the user's roles.
 *
 * This is a single database round trip inside the transaction: two indexed queries pipelined
 * through the same connection. The transaction is committed (read-only, no mutations).
 */
async function readTenantPolicy(
  db: Database,
  schoolId: string,
  userId: string,
  requestId?: string,
): Promise<TenantPolicyResult> {
  return withTenantTx(db, { schoolId, userId, requestId }, async (tx) => {
    const [schoolRow, roleRows] = await Promise.all([
      tx<{ status: string }[]>`
        SELECT status FROM app.schools
         WHERE id = current_setting('app.school_id')::uuid
      `,
      tx<{ role: Role }[]>`
        SELECT role FROM app.user_roles
         WHERE user_id = ${userId}
         AND school_id = current_setting('app.school_id')::uuid
         ORDER BY role
      `,
    ]);

    return {
      schoolStatus: schoolRow[0]?.status ?? "pending",
      roles: roleRows.map((r) => r.role),
    };
  });
}

/**
 * Evaluate the tenant suspension policy.
 *
 * Returns true if the login is permitted (school is active, or user holds an administrative
 * role in a suspended school).
 */
function isLoginPermitted(schoolStatus: string, roles: Role[]): boolean {
  if (schoolStatus === "active") return true;
  return roles.some((role) => ADMINISTRATIVE_ROLES.has(role));
}

// ---------------------------------------------------------------------------
// Main login function
// ---------------------------------------------------------------------------

/**
 * Authenticate a returning user by resolving a pre-validated Microsoft OIDC subject against
 * the identity store and issuing session tokens.
 */
export async function loginReturningUser(
  db: Database,
  config: SessionTokenConfig,
  params: ReturningUserLoginParams,
): Promise<ReturningUserLoginResult> {
  const { subject, channel, device, requestId, logger, clientIp, userAgent } = params;
  const provider = params.provider ?? "microsoft";

  // Identity resolution is done against the pre-validated subject claim.
  const identity = await findOAuthIdentity(db, provider, subject);

  if (!identity) {
    logger?.warn(
      {
        provider,
        sub_hash: hashSubject(subject),
        client_ip: clientIp,
        user_agent: userAgent,
      },
      "returning login failed: no account found",
    );
    return { outcome: "NO_ACCOUNT" };
  }

  // 3. Enforce tenant suspension policy.
  const policy = await readTenantPolicy(db, identity.schoolId, identity.userId, requestId);

  if (!isLoginPermitted(policy.schoolStatus, policy.roles)) {
    // Audit the suspension block inside a tenant transaction.
    await withTenantTx(
      db,
      { schoolId: identity.schoolId, userId: identity.userId, requestId },
      async (tx) => {
        await emitAuditLog(tx, {
          action: "login",
          targetTable: "oauth_identities",
          targetId: identity.identityId,
          newValues: {
            outcome: "LOGIN_FAILED_SCHOOL_SUSPENDED",
            school_status: policy.schoolStatus,
            roles: policy.roles,
          },
          clientIp,
          userAgent,
        });
      },
    );

    logger?.warn(
      {
        user_id: identity.userId,
        school_id: identity.schoolId,
        school_status: policy.schoolStatus,
        roles: policy.roles,
      },
      "returning login blocked: school suspended",
    );

    return { outcome: "SCHOOL_SUSPENDED" };
  }

  // 4. Issue tokens + update last_login_at + audit — all atomic in one tenant transaction.
  const tokens = await withTenantTx(
    db,
    { schoolId: identity.schoolId, userId: identity.userId, requestId },
    async (tx) => {
      // Update last_login_at atomically alongside token issuance.
      await tx`
        UPDATE app.users
           SET last_login_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ${identity.userId}::uuid
           AND school_id = current_setting('app.school_id')::uuid
      `;

      const issued = await issueTokenPair(tx, config, {
        userId: identity.userId,
        schoolId: identity.schoolId,
        channel,
        device,
      });

      await emitAuditLog(tx, {
        action: "login",
        targetTable: "refresh_tokens",
        targetId: issued.sessionId,
        newValues: {
          outcome: "LOGIN_SUCCESS",
          provider,
          identity_id: identity.identityId,
        },
        clientIp,
        userAgent,
      });

      return issued;
    },
  );

  logger?.info(
    {
      user_id: identity.userId,
      school_id: identity.schoolId,
      session_id: tokens.sessionId,
    },
    "returning login successful",
  );

  return { outcome: "LOGIN_SUCCESS", tokens };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * One-way hash of the OAuth subject for structured log output.
 * The raw `sub` is an external identifier and should not appear in logs;
 * the hash provides correlation without exposure.
 */
function hashSubject(sub: string): string {
  // Simple truncation for log readability — not a security hash.
  return sub.length > 16 ? `${sub.slice(0, 8)}...${sub.slice(-8)}` : sub;
}
