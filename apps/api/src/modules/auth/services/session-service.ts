/**
 * Refresh-token issuance, rotation, and reuse detection — the session lifecycle (ST-071).
 *
 * A session is one row in `app.refresh_tokens` per token, chained by `family_id`. Every refresh
 * consumes the presented token and issues a new one into the same family, so a token is valid
 * exactly once. Re-presenting a token that was already consumed is the signal this whole design
 * exists for: it means two parties hold the same token, which only happens after a theft, so the
 * entire family is revoked and the legitimate holder is logged out along with the attacker. Losing a
 * session is the correct outcome — an attacker who keeps rotating silently forever is not.
 *
 * The functions here divide along a deliberate line. `issueTokenPair` and the revocation helpers
 * take a `TransactionSql` first, following the convention set by src/lib/events/emitter.ts and
 * middleware/auditEmitter.ts: the caller owns the transaction, so issuance can be composed into a
 * larger unit of work (a future login route mints a token and updates last_login_at atomically).
 * `rotateRefreshToken` takes the `Database` instead, because it must resolve a tenant before a
 * tenant transaction can exist — it owns its own transaction by necessity.
 *
 * See docs/architecture/SAD_13_session_model.md for the state machine and the threat model.
 */

import { randomUUID } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";

import { openTenantTx, withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { AuthException } from "../../../middleware/jwtAuth";
import { emitTokenReuseDetected } from "../auth-anomaly-events";
import { signAccessToken } from "../jwt/sign";
import { hashSecret, mintOpaqueToken, parseOpaqueToken } from "../tokens/opaque-token";

import type { Database } from "../../../db/client";
import type { SecurityEventSink } from "../../../lib/security/securityEventSink";
import type { Logger } from "../../../logger";
import type { AuthChannel } from "../channels";
import type { KeyStore } from "../jwt/key-store";
import type { Role, SubscriptionStatus } from "@studafy/constants";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SessionTokenConfig {
  keyStore: KeyStore;
  issuer: string;
  audience: string;
  /** Access-token lifetime. Threaded from env.JWT_ACCESS_TTL_SECONDS. */
  accessTtlSeconds: number;
  /** Refresh-token lifetime, applied fresh on every rotation. Threaded from env.JWT_REFRESH_TTL_SECONDS. */
  refreshTtlSeconds: number;
}

/** Device metadata captured from the request. Explicit scalars, never a serialized blob. */
export interface DeviceContext {
  deviceId?: string | null;
  deviceName?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}

/** What a caller gets back from issuance or rotation. The refresh token exists here and nowhere else. */
export interface IssuedTokenPair {
  accessToken: string;
  /** Full `<school>.<user>.<secret>` string. Returned once; only its digest is stored. */
  refreshToken: string;
  sessionId: string;
  familyId: string;
  channel: AuthChannel;
  refreshExpiresAt: Date;
  accessExpiresInSeconds: number;
}

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

export interface IssueTokenPairParams {
  userId: string;
  schoolId: string;
  channel: AuthChannel;
  device?: DeviceContext;
  /** Continue an existing rotation chain. Omit to start a new session. */
  familyId?: string;
  /** The token this one replaces. Set only when rotating. */
  parentTokenId?: string;
}

/**
 * Mint an access/refresh pair and persist the refresh token's digest.
 *
 * Roles are read from `app.user_roles` rather than accepted from the caller. They are an authority
 * claim, and the one place they can be sourced from without becoming forgeable is the table that
 * defines them — a login route that passed in a role list would be one bug away from privilege
 * escalation.
 */
export async function issueTokenPair(
  tx: TransactionSql,
  config: SessionTokenConfig,
  params: IssueTokenPairParams,
): Promise<IssuedTokenPair> {
  const [roles, subscriptionStatus] = await Promise.all([
    readUserRoles(tx, params.userId),
    readSubscriptionStatus(tx),
  ]);

  const minted = mintOpaqueToken(params.schoolId, params.userId);
  const device = params.device ?? {};
  const expiresAt = new Date(Date.now() + config.refreshTtlSeconds * 1000);
  // Generated here rather than by a gen_random_uuid() default so the value is a plain bound
  // parameter in both statements below — mixing a SQL fragment into a parameter list is where
  // postgres.js template composition gets subtle, and this is not the place to be clever.
  const familyId = params.familyId ?? randomUUID();

  // The access token's identity is decided here rather than inside signAccessToken, because the
  // session row has to carry it: ST-072 revokes a family by projecting these two columns out of the
  // UPDATE and denylisting what it finds. A jti the signer kept to itself would be unrecoverable the
  // moment the response left the process, which is exactly the state ST-070's denylist sat in — a
  // revoke() with nothing able to call it.
  const accessJti = randomUUID();
  const accessExpiresAt = new Date(Date.now() + config.accessTtlSeconds * 1000);

  const [row] = await tx<{ id: string; family_id: string }[]>`
    INSERT INTO app.refresh_tokens (
      school_id, user_id, token_hash, family_id, parent_token_id,
      device_id, channel, device_name, user_agent, ip_address, expires_at,
      access_jti, access_expires_at
    ) VALUES (
      current_setting('app.school_id')::uuid,
      ${params.userId},
      ${minted.secretHash},
      ${familyId},
      ${params.parentTokenId ?? null},
      ${device.deviceId ?? null},
      ${params.channel},
      ${device.deviceName ?? null},
      ${device.userAgent ?? null},
      ${device.ipAddress ?? null},
      ${expiresAt},
      ${accessJti},
      ${accessExpiresAt}
    )
    RETURNING id, family_id
  `;

  const accessToken = await signAccessToken(
    config.keyStore,
    {
      sub: params.userId,
      school_id: params.schoolId,
      roles,
      entitlements_ver: 1,
      channel: params.channel,
      subscription_status: subscriptionStatus,
    },
    {
      issuer: config.issuer,
      audience: config.audience,
      ttlSeconds: config.accessTtlSeconds,
      jti: accessJti,
    },
  );

  return {
    accessToken,
    refreshToken: minted.token,
    sessionId: row!.id,
    familyId: row!.family_id,
    channel: params.channel,
    refreshExpiresAt: expiresAt,
    accessExpiresInSeconds: config.accessTtlSeconds,
  };
}

/**
 * Every role the user holds in the current tenant.
 *
 * A user with no roles cannot be issued a token. That is a data-integrity failure rather than an
 * authorization outcome — `app.user_roles` is populated when a user is activated — and returning an
 * empty array would mint a token that authenticates but authorizes nothing, which is far harder to
 * diagnose downstream than a refusal here.
 */
async function readUserRoles(tx: TransactionSql, userId: string): Promise<Role[]> {
  const rows = await tx<{ role: Role }[]>`
    SELECT role FROM app.user_roles WHERE user_id = ${userId} ORDER BY role
  `;

  if (rows.length === 0) {
    throw new AuthException(ERROR_CODES.AUTH_SESSION_NOT_FOUND, "User has no roles in this tenant");
  }

  return rows.map((row) => row.role);
}

/**
 * Read the tenant's current subscription lifecycle status.
 *
 * Defaults to "trialing" if no subscription row exists — a defensive fallback for tenants
 * that have not yet been fully provisioned. The provisioning pipeline creates the subscription
 * row, but there is a window between school creation and provisioning completion where the row
 * may not exist yet.
 */
async function readSubscriptionStatus(tx: TransactionSql): Promise<SubscriptionStatus> {
  const [row] = await tx<{ status: SubscriptionStatus }[]>`
    SELECT status FROM app.subscriptions
    WHERE school_id = current_setting('app.school_id')::uuid
  `;
  return row?.status ?? "trialing";
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

export interface RotateParams {
  presentedToken: string;
  requestId?: string;
  device?: DeviceContext;
  log?: Logger;
  /** Where auth anomaly events are persisted. Omitted in tests. */
  eventSink?: SecurityEventSink | null;
}

/**
 * Consume a refresh token and issue its replacement.
 *
 * The sequence is fixed by the RLS ordering problem described in
 * db/migrations/000029_add_refresh_token_session_columns.sql: the tenant must be known before any
 * tenant-scoped query can run, so the tenant and user are read out of the token itself and
 * everything happens inside one fully fenced transaction.
 *
 * Every rejection below is the same 401 with a code the client can act on, and deliberately reveals
 * nothing about which check failed beyond expired-versus-not. A caller probing tokens learns only
 * "no" — not whether the ids named a real tenant, whether the secret was close, or whether the session
 * belongs to a real user.
 */
export async function rotateRefreshToken(
  database: Database,
  config: SessionTokenConfig,
  params: RotateParams,
): Promise<IssuedTokenPair> {
  const parsed = parseOpaqueToken(params.presentedToken);
  if (!parsed) {
    throw new AuthException(ERROR_CODES.AUTH_TOKEN_INVALID, "Invalid refresh token");
  }

  // --- 1. Tenant context comes from the token itself -------------------------
  //
  // Unverified at this point, and that is fine: they are used only to scope the lookup, and the
  // lookup still has to find a row whose token_hash matches the presented secret *within* that
  // scope. Wrong ids find nothing. See opaque-token.ts for why they are in the token at all.
  const tenant = {
    schoolId: parsed.schoolId,
    userId: parsed.userId,
    requestId: params.requestId,
  };

  // The row lock is the concurrency boundary. A second request for the same token waits here, then
  // reads the version consumed by the winner and enters the reuse branch in this same transaction.
  const transaction = await openTenantTx(database, tenant, (tx) =>
    loadSessionForRotation(tx, hashSecret(parsed.secret)),
  );
  let outcome: RotationOutcome;
  let committed = false;

  try {
    const tx = transaction.tx;
    const session = transaction.initial;
    outcome = await (async (): Promise<RotationOutcome> => {
      // Finding a row is the secret verification: the digest matched inside both tenant and user RLS
      // fences. Wrong locators and wrong secrets are indistinguishable from an absent session.
      if (!session) return { kind: "not_found" };

      // Reuse is checked before expiry. The revocation and audit record must commit, so the public
      // exception is raised only after this transaction returns successfully.
      if (session.rotated_at !== null || session.revoked_at !== null) {
        return { kind: "reuse", event: await revokeReusedSession(tx, session) };
      }

      if (session.expires_at.getTime() <= Date.now()) return { kind: "expired" };

      if (session.roles.length === 0) {
        throw new AuthException(
          ERROR_CODES.AUTH_SESSION_NOT_FOUND,
          "User has no roles in this tenant",
        );
      }

      const minted = mintOpaqueToken(session.school_id, session.user_id);
      const childId = randomUUID();
      const expiresAt = new Date(Date.now() + config.refreshTtlSeconds * 1000);
      // Generated up front, like childId above and for the same reason: signing and persistence run
      // concurrently below, so every value both statements need has to exist before either starts.
      // Taking the jti back from the signer would serialize them.
      const accessJti = randomUUID();
      const accessExpiresAt = new Date(Date.now() + config.accessTtlSeconds * 1000);

      // Signing and persistence are independent once the locked row has supplied the claims. Run
      // them together, but do not commit until both succeed: a signing failure therefore rolls the
      // inserted child and parent transition back as one unit.
      const accessTokenPromise = signAccessToken(
        config.keyStore,
        {
          sub: session.user_id,
          school_id: session.school_id,
          roles: session.roles,
          entitlements_ver: 1,
          channel: session.channel,
          subscription_status: await readSubscriptionStatus(tx),
        },
        {
          issuer: config.issuer,
          audience: config.audience,
          ttlSeconds: config.accessTtlSeconds,
          jti: accessJti,
        },
      );

      const persistencePromise = tx<{ session_id: string; family_id: string }[]>`
      WITH child AS (
        INSERT INTO app.refresh_tokens (
          id, school_id, user_id, token_hash, family_id, parent_token_id,
          device_id, channel, device_name, user_agent, ip_address, expires_at,
          access_jti, access_expires_at
        ) VALUES (
          ${childId},
          current_setting('app.school_id')::uuid,
          ${session.user_id},
          ${minted.secretHash},
          ${session.family_id},
          ${session.id},
          ${session.device_id},
          ${session.channel},
          ${session.device_name},
          ${params.device?.userAgent ?? session.user_agent},
          ${params.device?.ipAddress ?? session.ip_address},
          ${expiresAt},
          ${accessJti},
          ${accessExpiresAt}
        )
        RETURNING id, family_id
      )
      UPDATE app.refresh_tokens AS parent
         SET rotated_at = CURRENT_TIMESTAMP,
             replaced_by_token_id = child.id
        FROM child
       WHERE parent.id = ${session.id}
         AND parent.rotated_at IS NULL
         AND parent.revoked_at IS NULL
      RETURNING child.id AS session_id, child.family_id
      `.execute();

      const [signingResult, persistenceResult] = await Promise.allSettled([
        accessTokenPromise,
        persistencePromise,
      ]);
      // Drain both operations before throwing so rollback is never queued behind an in-flight
      // statement on the reserved connection.
      if (signingResult.status === "rejected") throw signingResult.reason;
      if (persistenceResult.status === "rejected") throw persistenceResult.reason;

      const accessToken = signingResult.value;
      const persisted = persistenceResult.value;
      const row = persisted[0];
      if (!row) throw new Error("locked refresh token was not consumed");
      await transaction.commit();
      committed = true;

      return {
        kind: "issued",
        pair: {
          accessToken,
          refreshToken: minted.token,
          sessionId: row.session_id,
          familyId: row.family_id,
          channel: session.channel,
          refreshExpiresAt: expiresAt,
          accessExpiresInSeconds: config.accessTtlSeconds,
        },
      };
    })();
    if (!committed) await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  if (outcome.kind === "issued") return outcome.pair;
  if (outcome.kind === "not_found") {
    throw new AuthException(ERROR_CODES.AUTH_SESSION_NOT_FOUND, "Invalid refresh token");
  }
  if (outcome.kind === "expired") {
    throw new AuthException(ERROR_CODES.AUTH_TOKEN_EXPIRED, "Refresh token has expired");
  }

  emitTokenReuseDetected(params.log, params.eventSink, {
    familyId: outcome.event.familyId,
    sessionId: outcome.event.sessionId,
    deviceId: outcome.event.deviceId,
    revokedTokenCount: outcome.event.revokedTokenCount,
    clientIp: params.device?.ipAddress,
    userAgent: params.device?.userAgent,
  });
  throw new AuthException(ERROR_CODES.AUTH_TOKEN_INVALID, "Invalid refresh token");
}

/**
 * Burn down a compromised token family.
 *
 * Three things happen together, in one transaction, and the audit row is part of that atomicity
 * rather than a best-effort afterthought: emitAuditLog throws on failure, which rolls the revocation
 * back. A revocation nobody can prove happened is worse than one that visibly failed.
 *
 * The device is revoked alongside the family because ST-071 requires active sessions for the device
 * to be cleared, and app.user_devices is what "the device" means in this schema — leaving its push
 * token live would keep delivering notifications to a handset an attacker holds.
 */
async function revokeReusedSession(tx: TransactionSql, session: SessionRow): Promise<ReuseEvent> {
  const revoked = await tx`
    UPDATE app.refresh_tokens
       SET revoked_at = CURRENT_TIMESTAMP
     WHERE family_id = ${session.family_id}
       AND revoked_at IS NULL
    RETURNING id
  `;

  if (session.device_id !== null) {
    await tx`
      UPDATE app.user_devices
         SET revoked_at = CURRENT_TIMESTAMP
       WHERE id = ${session.device_id}
         AND revoked_at IS NULL
    `;
  }

  await emitAuditLog(tx, {
    action: "logout",
    targetTable: "refresh_tokens",
    // The family, not the individual token: the family is what was revoked, and it is the id that
    // makes every row in the chain findable from this one audit entry.
    targetId: session.family_id,
    newValues: {
      reason: "refresh_token_reuse_detected",
      family_id: session.family_id,
      session_id: session.id,
      device_id: session.device_id,
      revoked_token_count: revoked.length,
    },
    userAgent: session.user_agent,
    clientIp: session.ip_address,
  });

  return {
    familyId: session.family_id,
    sessionId: session.id,
    deviceId: session.device_id,
    revokedTokenCount: revoked.length,
  };
}

// ---------------------------------------------------------------------------
// Session enumeration and termination
// ---------------------------------------------------------------------------

export interface ActiveSession {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  channel: AuthChannel;
  userAgent: string | null;
  ipAddress: string | null;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * The caller's live sessions — one row per family, not per token.
 *
 * A 30-day-old session has rotated hundreds of times and left every consumed token behind as a row.
 * Listing tokens would show a user hundreds of entries for one browser. DISTINCT ON collapses each
 * family to its live tip, which is what a human means by "a session".
 */
export async function listActiveSessions(
  tx: TransactionSql,
  userId: string,
): Promise<ActiveSession[]> {
  const rows = await tx<
    {
      id: string;
      device_id: string | null;
      device_name: string | null;
      channel: AuthChannel;
      user_agent: string | null;
      ip_address: string | null;
      issued_at: Date;
      expires_at: Date;
    }[]
  >`
    SELECT DISTINCT ON (family_id)
      id, device_id, device_name, channel, user_agent, ip_address, issued_at, expires_at
    FROM app.refresh_tokens
    WHERE user_id = ${userId}
      AND revoked_at IS NULL
      AND rotated_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    ORDER BY family_id, issued_at DESC
  `;

  // token_hash is absent from the projection by design, not by oversight: this response
  // is handed to a client, and either one would turn a session list into a set of credentials.
  return rows.map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    channel: row.channel,
    userAgent: row.user_agent,
    ipAddress: row.ip_address,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  }));
}

/** A registered device and how many live sessions are currently bound to it. */
export interface UserDevice {
  id: string;
  platform: string;
  lastSeen: Date;
  createdAt: Date;
  activeSessionCount: number;
}

/**
 * The caller's registered, unrevoked devices.
 *
 * Distinct from listActiveSessions, which enumerates token families. A device is the physical thing
 * a person recognises and wants to revoke — "my old phone" — whereas a family is a login on it, and
 * one device can carry several. The session count is what makes the list actionable rather than
 * merely informational.
 *
 * fcm_token is absent from the projection for the same reason token_hash is absent from the session
 * list: it is a credential for the push channel, and this response is handed to a client.
 */
export async function listUserDevices(tx: TransactionSql, userId: string): Promise<UserDevice[]> {
  const rows = await tx<
    {
      id: string;
      platform: string;
      last_seen: Date;
      created_at: Date;
      active_session_count: string;
    }[]
  >`
    SELECT d.id, d.platform::text AS platform, d.last_seen, d.created_at,
           count(rt.family_id) AS active_session_count
      FROM app.user_devices AS d
      LEFT JOIN app.refresh_tokens AS rt
             ON rt.device_id = d.id
            AND rt.revoked_at IS NULL
            AND rt.rotated_at IS NULL
            AND rt.expires_at > CURRENT_TIMESTAMP
     WHERE d.user_id = ${userId}
       AND d.revoked_at IS NULL
     GROUP BY d.id, d.platform, d.last_seen, d.created_at
     ORDER BY d.last_seen DESC
  `;

  return rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
    // count() comes back as a bigint, which postgres.js surfaces as a string to avoid a silent
    // precision loss past 2^53. Harmless for a session count, but the cast has to be explicit or the
    // JSON response would carry a quoted number.
    activeSessionCount: Number(row.active_session_count),
  }));
}

/**
 * Soft-revoke a device registration.
 *
 * Sets revoked_at rather than deleting, matching how app.user_devices is treated everywhere else in
 * this schema (000017 makes soft revocation the rule and app.claim_device_token the precedent): the
 * row is evidence for a later investigation, and a delete would also break the composite foreign key
 * every refresh_tokens row bound to this device holds.
 *
 * Scoped to the caller's own user_id in addition to the RLS fence, so a device id belonging to
 * another user in the same tenant matches nothing rather than being deregistered.
 */
export async function deregisterDevice(
  tx: TransactionSql,
  userId: string,
  deviceId: string,
): Promise<number> {
  const revoked = await tx`
    UPDATE app.user_devices
       SET revoked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ${deviceId}
       AND user_id = ${userId}
       AND revoked_at IS NULL
    RETURNING id
  `;
  return revoked.length;
}

/** Where a presented refresh token points: its tenant, its family, and the metadata to audit with. */
export interface ResolvedFamily {
  schoolId: string;
  userId: string;
  familyId: string;
  userAgent: string | null;
  ipAddress: string | null;
}

/**
 * Resolve a presented refresh token to the family it belongs to, without revoking anything.
 *
 * Logout needs the tenant, the user, and the family before it can open a revoking transaction, and
 * it has none of them: it is an unauthenticated route, so there is no access token and no auth
 * context. The token itself is the only source, which is why the wire format carries the two ids —
 * see 000029's header.
 *
 * Returns undefined for an unparseable or unknown token rather than throwing. Logout is
 * unauthenticated and answers 200 either way; reporting "that token does not exist" to a caller
 * asking to destroy it would be a probing oracle, and there is nothing a client could do
 * differently.
 *
 * Matching on the digest is what makes this safe to expose unauthenticated: the ids in the token
 * only scope the search, and a caller who knows someone's school and user ids but not their secret
 * finds nothing. Otherwise a pair of identifiers the access token already publishes as claims would
 * become a denial-of-service primitive.
 */
export async function resolveFamilyByToken(
  database: Database,
  presentedToken: string,
  requestId?: string,
): Promise<ResolvedFamily | undefined> {
  const parsed = parseOpaqueToken(presentedToken);
  if (!parsed) return undefined;

  const tenant = { schoolId: parsed.schoolId, userId: parsed.userId, requestId };

  const session = await withTenantTx(database, tenant, (tx) =>
    loadSessionByHash(tx, hashSecret(parsed.secret)),
  );
  if (!session) return undefined;

  return {
    schoolId: session.school_id,
    userId: session.user_id,
    familyId: session.family_id,
    userAgent: session.user_agent,
    ipAddress: session.ip_address,
  };
}

// ---------------------------------------------------------------------------
// Shared internals
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  school_id: string;
  user_id: string;
  token_hash: Buffer;
  family_id: string;
  device_id: string | null;
  channel: AuthChannel;
  device_name: string | null;
  user_agent: string | null;
  ip_address: string | null;
  expires_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
}

interface RotationSessionRow extends SessionRow {
  roles: Role[];
}

interface ReuseEvent {
  familyId: string;
  sessionId: string;
  deviceId: string | null;
  revokedTokenCount: number;
}

type RotationOutcome =
  | { kind: "issued"; pair: IssuedTokenPair }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "reuse"; event: ReuseEvent };

/** Lock the presented row and fetch its authoritative roles in the same indexed round trip. */
function loadSessionForRotation(
  tx: TransactionSql,
  tokenHash: Buffer,
): Promise<RotationSessionRow | undefined> {
  return tx<RotationSessionRow[]>`
    SELECT rt.id, rt.school_id, rt.user_id, rt.token_hash, rt.family_id, rt.device_id,
           rt.channel, rt.device_name, rt.user_agent, rt.ip_address, rt.expires_at,
           rt.rotated_at, rt.revoked_at,
           ARRAY(
             SELECT ur.role::text
               FROM app.user_roles AS ur
              WHERE ur.user_id = rt.user_id
              ORDER BY ur.role
           )::text[] AS roles
      FROM app.refresh_tokens AS rt
     WHERE rt.token_hash = ${tokenHash}
       FOR UPDATE OF rt
  `.then((rows) => rows[0]);
}

/**
 * Find a session by the digest of its secret.
 *
 * Runs inside a tenant transaction, so tenant_isolation and refresh_tokens_owner both apply on top
 * of the `token_hash` match. uq_refresh_tokens_token_hash makes it a unique index point-lookup.
 */
function loadSessionByHash(tx: TransactionSql, tokenHash: Buffer): Promise<SessionRow | undefined> {
  return tx<SessionRow[]>`
    SELECT id, school_id, user_id, token_hash, family_id, device_id, channel,
           device_name, user_agent, ip_address, expires_at, rotated_at, revoked_at
      FROM app.refresh_tokens
     WHERE token_hash = ${tokenHash}
  `.then((rows) => rows[0]);
}
