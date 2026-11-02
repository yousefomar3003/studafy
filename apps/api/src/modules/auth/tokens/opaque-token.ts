/**
 * Opaque refresh-token minting and verification primitives.
 *
 * Access tokens are JWTs: structured, self-describing, verified by signature. Refresh tokens are the
 * opposite by design — a refresh token carries no claims at all, means nothing to anyone holding it,
 * and is verified by looking it up. That is what makes server-side revocation possible, which is the
 * entire reason the two token types differ (see docs/architecture/SAD_13_session_model.md).
 *
 * A token is three parts joined by dots:
 *
 *     <school_uuid>.<user_uuid>.<secret>
 *      │             │           └── 256 bits of CSPRNG output, base64url. The credential.
 *      │             └── owner of the session
 *      └── tenant the session belongs to
 *
 * The two ids are there to solve an ordering problem in the data layer, not for any cryptographic
 * reason. A refresh request carries no access token, so there is no verified `school_id`, and
 * src/db/tenant-tx.ts cannot open a transaction without one — every policy from 000006 compares
 * against `current_setting('app.school_id')` with no `missing_ok`, so an unset GUC raises rather
 * than matching nothing. The restrictive `refresh_tokens_owner` policy makes the same true of
 * `app.user_id`. Both have to be known before the row that holds them can be read.
 *
 * **This discloses nothing.** The access token issued to the same client already carries `school_id`
 * and `sub` as claims. Nor does it hand a caller a scope to attack: forged ids open a transaction
 * scoped to that tenant and user, where the presented secret still has to hash to a stored
 * `token_hash` owned by them. Wrong ids find nothing.
 *
 * Two other designs were tried and are recorded in
 * db/migrations/000029_add_refresh_token_session_columns.sql — a `SECURITY DEFINER` lookup (blocked
 * by `FORCE ROW LEVEL SECURITY` and the deliberate absence of any `BYPASSRLS` role) and a global
 * locator directory (rejected by db/policies/rls-coverage.ts, which permits no relation that is both
 * global and carries `school_id`).
 *
 * Only the secret is hashed, and only the hash is stored. Nothing in this module writes, logs, or
 * returns anything that would let a stored row be turned back into a usable token.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Bytes of entropy in the secret half. 256 bits, per ST-071. */
const SECRET_BYTES = 32;

/** Bytes in a SHA-256 digest. Matches `ck_refresh_tokens_token_hash`, which CHECKs for exactly 32. */
const DIGEST_BYTES = 32;

/** Separator between the two halves. Not in the base64url alphabet, so the split is unambiguous. */
const SEPARATOR = ".";

/** A freshly minted token, split into the parts the caller needs to store versus return. */
export interface MintedToken {
  /**
   * The full `<school_uuid>.<user_uuid>.<secret>` string. Handed to the client exactly once and
   * never persisted in any form — this is the only moment it exists outside the client.
   */
  token: string;
  /** SHA-256 of the secret half. The only representation of the secret that is ever stored. */
  secretHash: Buffer;
}

/**
 * Mint a new opaque refresh token for a session.
 *
 * `crypto.getRandomValues` rather than `Math.random` or a uuid for the secret: this is a bearer
 * credential, so it needs a CSPRNG, and 256 bits puts guessing far outside reach regardless of how
 * many tokens are live. A uuid would give only 122 bits and is not specified to be
 * cryptographically random.
 */
export function mintOpaqueToken(schoolId: string, userId: string): MintedToken {
  const secretBytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(secretBytes);

  const secret = toBase64Url(secretBytes);

  return {
    token: `${schoolId}${SEPARATOR}${userId}${SEPARATOR}${secret}`,
    secretHash: hashSecret(secret),
  };
}

/** The three parts of a token that parsed cleanly. */
export interface ParsedToken {
  schoolId: string;
  userId: string;
  secret: string;
}

/**
 * Split a presented token into its parts, or return `null` if it is not well-formed.
 *
 * Returns `null` rather than throwing because a malformed token is an ordinary client error on an
 * unauthenticated endpoint, not an exceptional condition — the caller turns it into the same 401 as
 * a well-formed token that does not resolve, and deliberately not a distinguishable one. Telling a
 * caller apart "malformed" from "unknown" would let them probe the token format.
 *
 * Both ids are checked against the uuid shape before either is used in a query. That is a validation
 * boundary rather than an injection defence — the query is parameterised either way — but it matters
 * for two reasons on an endpoint reachable without authentication: a garbage token is rejected
 * in-process instead of costing a database round trip, and the ids are about to be fed to
 * `set_config` as the tenant and user context, so they must be known-shaped before they get there.
 */
export function parseOpaqueToken(token: string): ParsedToken | null {
  const parts = token.split(SEPARATOR);
  if (parts.length !== 3) return null;

  const [schoolId, userId, secret] = parts as [string, string, string];

  if (!UUID_PATTERN.test(schoolId) || !UUID_PATTERN.test(userId)) return null;
  if (secret.length === 0 || !BASE64URL_PATTERN.test(secret)) return null;

  return { schoolId, userId, secret };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * SHA-256 of a token's secret half.
 *
 * Plain SHA-256, not a keyed HMAC and emphatically not a password hash, and the reason is the shape
 * of the input rather than convenience. Password hashing (bcrypt/argon2) is deliberately slow to
 * make guessing a low-entropy human-chosen secret expensive; this input is 256 bits of uniform
 * CSPRNG output, so there is no guessing attack to slow down and the cost would buy nothing while
 * landing on the rotation path's latency budget. A pepper is likewise omitted: it defends a
 * *stolen database* against offline recovery of the plaintext, which for a uniform 256-bit value is
 * already infeasible, and it would introduce a secret that has to be provisioned and rotated in
 * lockstep with the rows it protects. docs/api/auth-data-model.md says "SHA-256/HMAC"; this is the
 * SHA-256 arm of that, chosen explicitly rather than by default.
 *
 * Note this hashes the base64url *string*, not the bytes it decodes to. The verification path only
 * ever holds the string, so hashing it directly keeps that path a single straight-line digest with
 * no decode step that could disagree with the encode step.
 */
export function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Compare a presented secret against a stored digest in constant time.
 *
 * The timing-safe comparison is close to ceremony here and is kept anyway. A locator lookup has
 * already narrowed the candidate set to exactly one row, so a leaked comparison time would reveal a
 * prefix of a digest whose preimage is a 256-bit random value — not a practical attack. But "not
 * practical *given the current call site*" is a property of the caller, not of this function, and
 * the version of this that becomes wrong when someone later compares against a set is the fast one.
 *
 * Length is checked first because timingSafeEqual throws on a mismatch rather than returning false.
 * That check leaks only the digest length, which is a constant.
 */
export function verifySecret(secret: string, storedHash: Uint8Array): boolean {
  if (storedHash.length !== DIGEST_BYTES) return false;
  return timingSafeEqual(hashSecret(secret), storedHash);
}

/** Encode bytes as unpadded base64url. */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
