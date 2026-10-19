/**
 * School closure by the school's own administrator (POST /api/schools/current/closure).
 *
 * Closing a school is not deleting it. The school row moves to `archived` — the existing terminal
 * lifecycle state — and every row the school owns is kept: nothing is erased and no data subject
 * request is filed. What changes is who can get in, which is nobody:
 *
 * 1. `app.schools.status = 'archived'`, with `closed_at` / `closed_by` (migration 000128).
 * 2. The school's entitlement version is bumped. jwtAuthMiddleware rejects every access token
 *    minted before the bump, and for a closed school it answers SCHOOL_SUSPENDED (see
 *    modules/auth/school-access.ts) — so outstanding access tokens die on their next request rather
 *    than at their own expiry.
 * 3. Every session of every user in the school is revoked (refresh tokens and device push
 *    registrations), so nothing can be refreshed.
 * 4. One audit row for the closure, one for the teardown.
 *
 * All four commit or roll back together. After the commit, the entitlement cache's floor is moved
 * to the new version (so the JWT check sees it without waiting for the cache TTL), and students' AI
 * add-on billing is paused exactly as a platform archive does — both best-effort and logged, because
 * the closure itself has already happened and cannot be un-happened by a cache or provider error.
 *
 * Sign-in is refused from then on by the login policy and by issueTokenPair, both in
 * modules/auth.
 */

import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { CLOSED_SCHOOL_STATUS } from "../../auth/school-access";
import {
  REVOCATION_REASONS,
  revokeAllSchoolSessionsInTx,
} from "../../auth/services/revocation-service";
import {
  entitlementCacheKey,
  invalidateEntitlementEntry,
} from "../../subscriptions/entitlements/cache";
import { bumpEntitlementVersion } from "../../subscriptions/entitlements/version";
import { pauseAiSubscriptionsForSchoolSuspension } from "../../subscriptions/services/school-suspension-service";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { RedisClient } from "../../../redis";
import type { PaymentProviderPort } from "../../subscriptions/ports/payment-provider";

export interface CurrentSchool {
  id: string;
  name: string;
  status: string;
}

export interface SchoolClosureDeps {
  database: Database;
  /** Moves the entitlement cache floor after commit. Null when Redis is unconfigured. */
  redis: RedisClient | null;
  /** Pauses students' AI add-on billing after commit, as a platform archive does. Null skips it. */
  paymentProvider: PaymentProviderPort | null;
  /** Fallback logger for the post-commit steps when the request carries none. */
  logger: Logger;
}

export interface CloseSchoolParams {
  schoolId: string;
  /** The administrator closing the school; recorded as `closed_by` and as the audit actor. */
  userId: string;
  confirmSchoolName: string;
  reason?: string;
  requestId?: string;
  log?: Logger;
  userAgent?: string | null;
  clientIp?: string | null;
}

export interface SchoolClosureResult {
  schoolId: string;
  status: typeof CLOSED_SCHOOL_STATUS;
  closedAt: Date;
  usersSignedOut: number;
  sessionsRevoked: number;
}

/**
 * The comparison form of a school name: trimmed, Unicode-normalized and case-folded. Case-folding is
 * a no-op for Arabic, and NFC keeps a name typed on one keyboard comparable with one stored from
 * another.
 */
export function normalizeSchoolName(name: string): string {
  return name.trim().normalize("NFC").toLocaleLowerCase("en-US");
}

/** The caller's own school: its id, display name and lifecycle status. */
export async function getCurrentSchool(
  database: Database,
  schoolId: string,
): Promise<CurrentSchool> {
  const school = await withTenantTx(database, { schoolId }, async (tx) => {
    const [row] = await tx<CurrentSchool[]>`
      SELECT id::text AS id, name, status::text AS status
        FROM app.schools
       WHERE id = current_setting('app.school_id')::uuid
    `;
    return row;
  });

  if (!school) throw new HTTPException(404, { message: "School not found" });
  return school;
}

export async function closeSchool(
  deps: SchoolClosureDeps,
  params: CloseSchoolParams,
): Promise<SchoolClosureResult> {
  const { database, redis, paymentProvider } = deps;
  const { schoolId, userId, requestId, log } = params;

  const outcome = await withTenantTx(database, { schoolId, userId, requestId }, async (tx) => {
    // Locked so two concurrent closures (a double tap, a retry racing the original) serialize: the
    // second sees `archived` and is refused rather than writing a second closure record.
    const [school] = await tx<{ name: string; status: string }[]>`
      SELECT name, status::text AS status
        FROM app.schools
       WHERE id = current_setting('app.school_id')::uuid
         FOR UPDATE
    `;

    if (!school) throw new HTTPException(404, { message: "School not found" });

    if (school.status === CLOSED_SCHOOL_STATUS) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.CONFLICT_STATE_MISMATCH,
        "This school is already closed.",
      );
    }

    if (normalizeSchoolName(params.confirmSchoolName) !== normalizeSchoolName(school.name)) {
      throw new CodedHttpException(
        422,
        ERROR_CODES.SCHOOL_CLOSURE_NAME_MISMATCH,
        "The school name you typed does not match this school's name.",
      );
    }

    const [closed] = await tx<{ closed_at: Date }[]>`
      UPDATE app.schools
         SET status = ${CLOSED_SCHOOL_STATUS}::app.school_status,
             closed_at = CURRENT_TIMESTAMP,
             closed_by = ${userId}::uuid,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = current_setting('app.school_id')::uuid
      RETURNING closed_at
    `;

    // Every outstanding access token in the school now predates the school's version.
    const entitlementsVersion = await bumpEntitlementVersion(tx, "school", schoolId);

    const revocation = await revokeAllSchoolSessionsInTx(tx);

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "schools",
      targetId: schoolId,
      oldValues: { status: school.status },
      newValues: {
        status: CLOSED_SCHOOL_STATUS,
        source: "school_admin_closure",
        reason: params.reason ?? null,
        closed_at: closed!.closed_at.toISOString(),
        entitlements_version: entitlementsVersion,
        users_signed_out: revocation.users,
        sessions_revoked: revocation.revokedTokens,
      },
      userAgent: params.userAgent ?? null,
      clientIp: params.clientIp ?? null,
    });

    // The teardown's own record, in the vocabulary every other revocation path writes.
    await emitAuditLog(tx, {
      action: "logout",
      targetTable: "refresh_tokens",
      targetId: schoolId,
      newValues: {
        reason: REVOCATION_REASONS.SCHOOL_CLOSURE,
        scope: "school",
        revoked_token_count: revocation.revokedTokens,
        user_count: revocation.users,
      },
      userAgent: params.userAgent ?? null,
      clientIp: params.clientIp ?? null,
    });

    return {
      closedAt: closed!.closed_at,
      entitlementsVersion,
      revocation,
    };
  });

  // --- After commit: best-effort propagation -------------------------------------------------
  if (redis) {
    try {
      await invalidateEntitlementEntry(
        redis,
        entitlementCacheKey(schoolId),
        outcome.entitlementsVersion,
      );
    } catch (err) {
      // The cache entry carries a TTL (ENTITLEMENT_CACHE_TTL_SECONDS), so a stale version cannot
      // outlive it; refresh is already closed by the revocation above.
      log?.error(
        { err, school_id: schoolId, event: "school_closure_cache_invalidation_failed" },
        "school closed but the entitlement cache floor could not be moved",
      );
    }
  }

  // Idempotent at the provider and in the state machine (only live subscriptions pause), so a school
  // with no AI add-ons costs one empty query.
  if (paymentProvider) {
    try {
      await pauseAiSubscriptionsForSchoolSuspension(
        database,
        paymentProvider,
        schoolId,
        log ?? deps.logger,
        requestId,
      );
    } catch (err) {
      log?.error(
        { err, school_id: schoolId, event: "school_closure_ai_billing_pause_failed" },
        "school closed but AI add-on billing could not be paused",
      );
    }
  }

  log?.info(
    {
      event: "school_closed",
      school_id: schoolId,
      users_signed_out: outcome.revocation.users,
      sessions_revoked: outcome.revocation.revokedTokens,
    },
    "school closed by its administrator",
  );

  return {
    schoolId,
    status: CLOSED_SCHOOL_STATUS,
    closedAt: outcome.closedAt,
    usersSignedOut: outcome.revocation.users,
    sessionsRevoked: outcome.revocation.revokedTokens,
  };
}
