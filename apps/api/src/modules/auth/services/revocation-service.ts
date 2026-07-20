/**
 * Session teardown — the dual-layer revocation coordinator (ST-072).
 *
 * Revoking a session has to happen in two places at once, because a session lives in two places.
 * The refresh token is a row in `app.refresh_tokens` and dies when `revoked_at` is set. The access
 * token is stateless — nothing is consulted to prove one is valid — so it keeps working until its
 * own `exp` unless something says otherwise, and the Redis denylist from ST-070 is that something.
 * Doing only the first is what shipped before this module existed, and it left a fifteen-minute
 * window (`JWT_ACCESS_TTL_SECONDS`) in which a logged-out credential still opened every endpoint.
 *
 * Every revocation path in the application funnels through `revokeAndDenylist` so that window
 * cannot reopen one route at a time.
 *
 * ORDERING, AND WHY IT IS NOT THE OTHER WAY AROUND.
 *
 * Postgres commits first, Redis second. The two stores cannot be made atomic with each other, so
 * the question is which inconsistency to prefer when the second step fails, and they are not
 * symmetric:
 *
 *   - Commit-then-denylist can leave a revoked family whose access token is briefly still live. That
 *     is the status quo ante for at most one access-token TTL, it is loud (this module throws), and
 *     the refresh path is already closed so the session cannot extend itself.
 *   - Denylist-then-commit can deny tokens for a transaction that then rolls back — logging a user
 *     out of a session the database still considers live, with no record of why. Worse, it fails
 *     *open* on the audit trail: the eviction happened and nothing recorded it.
 *
 * The audit row is written inside the same transaction as the UPDATE, following the rule
 * revokeReusedSession established in session-service.ts: `emitAuditLog` throws on failure and rolls
 * the revocation back with it, because a revocation nobody can prove happened is worse than one that
 * visibly failed.
 */

import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { Database } from "../../../db/client";
import type { TenantContext } from "../../../db/tenant-tx";
import type { Logger } from "../../../logger";
import type { DenylistEntry, JtiDenylist } from "../denylist";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Why a teardown happened.
 *
 * `app.audit_action` is a closed Postgres enum whose nearest label is `logout`, and every one of
 * these is a logout in the sense that enum means. The distinction between them lives in a `reason`
 * field on the audit payload instead, extending the vocabulary session-service.ts already writes
 * (`user_logout`, `refresh_token_reuse_detected`). Adding enum values would be a schema change with
 * transaction restrictions on ALTER TYPE, and would force every existing audit reader to widen —
 * for no gain a queryable JSON field does not already provide.
 */
export const REVOCATION_REASONS = {
  LOGOUT_SINGLE: "logout_single",
  REVOKE_SESSION: "revoke_session",
  REVOKE_DEVICE: "revoke_device",
  REVOKE_ALL_DEVICES: "revoke_all_devices",
  ADMIN_REVOKE_DEVICE: "admin_revoke_device",
  ADMIN_REVOKE_ALL_DEVICES: "admin_revoke_all_devices",
} as const;

export type RevocationReason = (typeof REVOCATION_REASONS)[keyof typeof REVOCATION_REASONS];

/**
 * What to tear down.
 *
 * A discriminated union rather than an options bag with three optional ids, so "revoke a device"
 * cannot be written without a device id and cannot accidentally carry a family id that silently
 * narrows it. `userId` is mandatory on every variant: it is half of the tenant-scoping predicate
 * every query below asserts, and it is what `refresh_tokens_owner` compares against.
 */
export type RevocationScope =
  /** Everything in one rotation chain. Logout resolves its token to this. */
  | { kind: "family"; familyId: string }
  /** One session named by the id of its live token; resolved to its family before revoking. */
  | { kind: "session"; sessionId: string }
  /** Every family bound to one device. */
  | { kind: "device"; deviceId: string }
  /** Every family the user has, on any device. */
  | { kind: "user" };

export interface RevocationResult {
  /** Refresh-token rows moved to revoked. Zero means nothing matched — see the note on oracles. */
  revokedTokens: number;
  /** Access-token ids written to the denylist. Never exceeds revokedTokens. */
  denylistedJtis: number;
}

export interface RevokeParams {
  database: Database;
  /** Null when Redis is unconfigured. See the degradation note in revokeAndDenylist. */
  denylist: JtiDenylist | null;
  /** Tenant context for the revoking transaction. `userId` is the *actor*, not necessarily the target. */
  tenant: TenantContext;
  /** The user whose sessions are being revoked. Equal to `tenant.userId` on every self-service path. */
  targetUserId: string;
  scope: RevocationScope;
  reason: RevocationReason;
  log?: Logger;
  userAgent?: string | null;
  clientIp?: string | null;
}

/** Projection of the revoking UPDATE: enough to denylist, and nothing that is a credential. */
interface RevokedRow {
  id: string;
  family_id: string;
  access_jti: string | null;
  access_expires_at: Date | null;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Revoke a scope's token families and denylist the access tokens they minted.
 *
 * Returns counts rather than throwing when nothing matched. A scope that names a nonexistent
 * session, one already revoked, or one belonging to another user are deliberately indistinguishable
 * — `refresh_tokens_owner` makes the last case return no rows exactly as the first does, and
 * reporting the difference would turn every revocation route into an oracle for enumerating other
 * users' session and device ids. The routes surface this as `200 {revoked: 0}`.
 */
export async function revokeAndDenylist(params: RevokeParams): Promise<RevocationResult> {
  const { database, denylist, tenant, targetUserId, scope, reason, log } = params;

  // --- 1. Postgres: revoke and audit, atomically ----------------------------
  const revoked = await withTenantTx(database, tenant, async (tx) => {
    const rows = await revokeScope(tx, targetUserId, scope);

    await emitAuditLog(tx, {
      action: "logout",
      targetTable: "refresh_tokens",
      // The family, not a token id, matching revokeReusedSession: the family is the unit that was
      // revoked, and it is the id that makes every row in the chain findable from this one entry.
      // A multi-family scope files under the first, with the full list in the payload.
      targetId: rows[0]?.family_id ?? targetUserId,
      newValues: {
        reason,
        scope: scope.kind,
        target_user_id: targetUserId,
        family_ids: [...new Set(rows.map((row) => row.family_id))],
        device_id: scope.kind === "device" ? scope.deviceId : null,
        revoked_token_count: rows.length,
      },
      userAgent: params.userAgent ?? null,
      clientIp: params.clientIp ?? null,
    });

    return rows;
  });

  // --- 2. Redis: denylist the orphaned access tokens ------------------------
  const denylisted = await denylistRevoked(denylist, revoked, { reason, targetUserId, log });

  return { revokedTokens: revoked.length, denylistedJtis: denylisted };
}

/**
 * Revoke every family the scope reaches, for one user, within one tenant.
 *
 * Whole families, never the matched rows alone. A caller holding the live tip of a chain would keep
 * refreshing if only the row bearing the matched `device_id` were revoked — the family is the unit
 * of revocation everywhere in this subsystem.
 *
 * Both `user_id` and `school_id` are asserted explicitly on the outer UPDATE even though RLS already
 * fences both. That redundancy is the point: it makes the tenant boundary visible in the statement
 * rather than resident in a policy two migrations away, and it is what stops a `family_id` harvested
 * from another tenant from selecting anything if a policy is ever loosened.
 */
function revokeScope(
  tx: TransactionSql,
  targetUserId: string,
  scope: RevocationScope,
): Promise<RevokedRow[]> {
  // A fragment appended to the CTE's WHERE clause. postgres.js composes nested template literals as
  // parameterized fragments rather than string concatenation, so the ids below remain bound
  // parameters and never reach the server as SQL text.
  //
  // The `session` case reaches through to the family deliberately: revoking only the row whose id
  // was named would leave the rest of the chain live, and the client holds the tip.
  const scopeFilter =
    scope.kind === "family"
      ? tx`AND rt.family_id = ${scope.familyId}`
      : scope.kind === "session"
        ? tx`AND rt.family_id = (
              SELECT inner_rt.family_id
                FROM app.refresh_tokens AS inner_rt
               WHERE inner_rt.id = ${scope.sessionId}
            )`
        : scope.kind === "device"
          ? tx`AND rt.device_id = ${scope.deviceId}`
          : tx``;

  return tx<RevokedRow[]>`
    WITH targeted AS (
      SELECT DISTINCT rt.family_id
        FROM app.refresh_tokens AS rt
       WHERE rt.user_id = ${targetUserId}
         AND rt.school_id = current_setting('app.school_id')::uuid
         AND rt.revoked_at IS NULL
         ${scopeFilter}
    )
    UPDATE app.refresh_tokens AS victim
       SET revoked_at = CURRENT_TIMESTAMP
      FROM targeted
     WHERE victim.family_id = targeted.family_id
       AND victim.user_id = ${targetUserId}
       AND victim.school_id = current_setting('app.school_id')::uuid
       AND victim.revoked_at IS NULL
    RETURNING victim.id, victim.family_id, victim.access_jti, victim.access_expires_at
  `;
}

/**
 * Write the revoked rows' access-token ids to the shared denylist.
 *
 * This is what makes revocation propagate: every API instance checks the same Redis keyspace on
 * every authenticated request, so an entry written here is enforced everywhere within one lookup
 * rather than after a cache generation or a deploy.
 *
 * Rows with no `access_jti` are skipped rather than treated as an error. They are sessions created
 * before migration 000030 added the column, and there is nothing recoverable to deny — the value was
 * never persisted. They are still revoked in Postgres, so the session cannot extend itself; only the
 * outstanding access token has to age out on its own.
 */
async function denylistRevoked(
  denylist: JtiDenylist | null,
  revoked: readonly RevokedRow[],
  context: { reason: RevocationReason; targetUserId: string; log?: Logger },
): Promise<number> {
  const entries: DenylistEntry[] = [];
  for (const row of revoked) {
    if (row.access_jti === null || row.access_expires_at === null) continue;
    entries.push({
      jti: row.access_jti,
      expUnixSeconds: Math.floor(row.access_expires_at.getTime() / 1000),
    });
  }

  if (entries.length === 0) return 0;

  if (denylist === null) {
    // Matches how jwtAuth.ts degrades without Redis: warn loudly, keep serving. The Postgres half of
    // the teardown has already committed, so the session is dead for refresh; what is lost is
    // sub-TTL eviction of the outstanding access token. Failing the request instead would leave the
    // caller unable to log out at all in a configuration the app otherwise supports.
    context.log?.warn(
      {
        event: "denylist_unavailable",
        reason: context.reason,
        target_user_id: context.targetUserId,
        pending_jti_count: entries.length,
      },
      "access tokens not denylisted — no Redis configured; revocation is Postgres-only",
    );
    return 0;
  }

  try {
    return await denylist.revokeMany(entries);
  } catch (error) {
    // Deliberately not swallowed. The families are revoked and the audit row is committed, but the
    // access tokens are still live, and answering 200 here would tell the caller their stolen token
    // was killed when it was not. A 503 is the honest answer: the durable half succeeded, the
    // propagation half did not, and the operation is safe to retry because every statement above is
    // idempotent under `revoked_at IS NULL`.
    context.log?.error(
      {
        event: "denylist_write_failed",
        reason: context.reason,
        target_user_id: context.targetUserId,
        pending_jti_count: entries.length,
        err: error instanceof Error ? error.message : String(error),
      },
      "token families revoked but access-token denylisting failed",
    );

    throw new HTTPException(503, {
      message: "Sessions were revoked but access tokens could not be denylisted. Retry.",
      cause: error,
    });
  }
}

// ---------------------------------------------------------------------------
// Administrative teardown
// ---------------------------------------------------------------------------

export interface AdminRevokeParams {
  database: Database;
  denylist: JtiDenylist | null;
  /** Tenant context of the *administrator*. Its userId becomes the audit actor. */
  tenant: TenantContext;
  targetUserId: string;
  /** Narrow to one device. Omit for a global logout across every device. */
  targetDeviceId?: string | null;
  reason: RevocationReason;
  log?: Logger;
  userAgent?: string | null;
  clientIp?: string | null;
}

/**
 * Revoke another user's sessions on an administrator's behalf.
 *
 * Separate from `revokeAndDenylist` because the query cannot be: `refresh_tokens_owner` is a
 * RESTRICTIVE policy comparing `user_id` to `app.current_user_id()`, so a statement issued as
 * studafy_app can only ever reach the caller's own rows. Migration 000030 provides
 * `app.admin_revoke_user_sessions`, a SECURITY DEFINER function (owned by the migration's
 * maintenance role) that the per-user policy does not bind while tenant isolation still does — see
 * that file's header.
 *
 * The transaction is opened with the *administrator's* identity, which is what makes the audit row
 * name the right actor: `emitAuditLog` reads `actor_id` from the `app.user_id` GUC. Opening it as
 * the target would have been the easy way past the policy and would have filed every forced logout
 * as though the victim performed it.
 */
export async function adminRevokeUserSessions(
  params: AdminRevokeParams,
): Promise<RevocationResult> {
  const { database, denylist, tenant, targetUserId, targetDeviceId, reason, log } = params;

  const revoked = await withTenantTx(database, tenant, async (tx) => {
    const rows = await tx<RevokedRow[]>`
      SELECT revoked_token_id AS id,
             revoked_family_id AS family_id,
             revoked_access_jti AS access_jti,
             revoked_access_expires_at AS access_expires_at
        FROM app.admin_revoke_user_sessions(${targetUserId}, ${targetDeviceId ?? null})
    `;

    await emitAuditLog(tx, {
      action: "logout",
      targetTable: "refresh_tokens",
      targetId: rows[0]?.family_id ?? targetUserId,
      newValues: {
        reason,
        scope: targetDeviceId != null ? "device" : "user",
        target_user_id: targetUserId,
        family_ids: [...new Set(rows.map((row) => row.family_id))],
        device_id: targetDeviceId ?? null,
        revoked_token_count: rows.length,
      },
      userAgent: params.userAgent ?? null,
      clientIp: params.clientIp ?? null,
    });

    return rows;
  });

  const denylisted = await denylistRevoked(denylist, revoked, { reason, targetUserId, log });

  return { revokedTokens: revoked.length, denylistedJtis: denylisted };
}
