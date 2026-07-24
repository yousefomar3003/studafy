import { ROLES, SUBSCRIPTION_STATUSES } from "@studafy/constants";
import { decodeProtectedHeader, errors as joseErrors, jwtVerify } from "jose";
import { z } from "zod";

import { AUTH_CHANNELS } from "../channels";

import type { KeyStore } from "./key-store";
import type { JwtPayload } from "./types";

/**
 * Why a token was rejected.
 *
 * The middleware maps these onto error codes and log fields, so it never has to pattern-match on
 * an error message string — messages come from `jose` and are not a stable interface.
 */
export type TokenFailureReason =
  /** Not three base64url segments, or the header is not decodable JSON. */
  | "malformed"
  /** Header `alg` is not RS256, or `kid` is absent/unknown to the key store. */
  | "key"
  /** Signature did not verify against the resolved public key. */
  | "signature"
  /** `exp` is in the past (or `nbf` is in the future). */
  | "expired"
  /** Signature is good, but `iss`/`aud`/application claims are not what we require. */
  | "claims"
  /** The key store holds no keys at all — a server fault, not a client one. */
  | "no_keys";

export class TokenVerificationError extends Error {
  constructor(
    reason: string,
    /** Machine-readable failure category. See {@link TokenFailureReason}. */
    readonly failure: TokenFailureReason = "claims",
  ) {
    super(`Token verification failed: ${reason}`);
    this.name = "TokenVerificationError";
  }
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
}

/**
 * A UUID exactly as wide as PostgreSQL's `uuid` type accepts: 32 hex digits in 8-4-4-4-12 form.
 *
 * Deliberately *not* `uuidSchema` from @studafy/shared-schemas, which is `z.uuid()` and so also
 * enforces the RFC 9562 version and variant nibbles. Those bits are not part of the contract we
 * actually have. `app.users.id` and `app.schools.id` are `uuid` columns
 * (db/migrations/000007_create_users_and_identity_tables.sql); `gen_random_uuid()` is only their
 * default, and the column will happily hold an id that arrived from a data import, a legacy system,
 * or a nil-UUID sentinel. Rejecting those here would 401 a user whose row is perfectly valid to
 * every other part of the system.
 *
 * What this check is actually for is narrower and still holds: the value is a fixed-length hex
 * string, so it cannot carry anything interesting into the `app.school_id` GUC or a query. Version
 * bits add no security on top of that.
 */
const pgUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid UUID");

/**
 * Shape of every claim we depend on, validated in one pass after the signature checks out.
 *
 * The point of validating here rather than at each use site is that `AuthContext` downstream is a
 * fully-typed, non-nullable value: `schoolId` feeds the `app.school_id` GUC that every RLS policy
 * reads (db/migrations/000006_create_rls_helper.sql), so a malformed one must never reach a
 * transaction. `sub`/`school_id` are checked as UUIDs because that is what the primary keys in
 * db/migrations/000007_create_users_and_identity_tables.sql actually are, and `roles` is checked
 * against ROLES — whose values are byte-identical to the `app.user_role` enum — so an unrecognised
 * role fails the whole token instead of silently degrading to a smaller permission set.
 */
const accessTokenClaimsSchema = z.object({
  sub: pgUuidSchema,
  school_id: pgUuidSchema,
  roles: z.array(z.enum(ROLES)).min(1),
  entitlements_ver: z.number().int(),
  jti: pgUuidSchema,
  channel: z.enum(AUTH_CHANNELS),
  subscription_status: z.enum(SUBSCRIPTION_STATUSES),
});

/** Translate a `jose` verification failure into our own reason taxonomy. */
function classify(err: unknown): TokenVerificationError {
  if (err instanceof joseErrors.JWTExpired) {
    return new TokenVerificationError("token expired", "expired");
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    // Covers iss/aud mismatch and a future nbf. `nbf` is grouped with claims rather than with
    // "expired" deliberately: a not-yet-valid token means clock skew or a forged token, not a
    // session that simply aged out, and the two should not read the same in the logs.
    return new TokenVerificationError(err.message, "claims");
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new TokenVerificationError("signature mismatch", "signature");
  }
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) {
    return new TokenVerificationError("malformed token", "malformed");
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed) {
    return new TokenVerificationError("algorithm not allowed", "key");
  }
  return new TokenVerificationError(
    err instanceof Error ? err.message : "unknown verification error",
    "signature",
  );
}

/**
 * Verify an RS256 access token against the KeyStore and return the validated payload. Throws
 * {@link TokenVerificationError} for any malformed, mis-signed, expired, or otherwise invalid
 * token.
 *
 * Key resolution goes through the token's own `kid` rather than handing jose the whole key set, so
 * verification performs exactly one signature check no matter how many keys are live. That single
 * RSA verification is where essentially all of the middleware's measured cost sits (~0.3 ms p95,
 * see tests/benchmark/jwt-auth-benchmark.test.ts); everything around it is bookkeeping.
 */
export async function verifyAccessToken(
  keyStore: KeyStore,
  token: string,
  options: VerifyOptions,
): Promise<JwtPayload> {
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new TokenVerificationError("undecodable protected header", "malformed");
  }

  // Pinned here as well as in jwtVerify below. jwtVerify's `algorithms` option is the check that
  // actually matters, but rejecting up front means a token claiming `none` or an HMAC algorithm
  // never reaches key resolution at all.
  if (header.alg !== "RS256") {
    throw new TokenVerificationError(`unsupported alg: ${String(header.alg)}`, "key");
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new TokenVerificationError("missing kid header", "key");
  }

  const publicKey = await keyStore.publicKeyFor(header.kid);
  if (!publicKey) {
    // Distinguish "the store is empty" (our fault, surfaced as 5xx upstream) from "this kid is not
    // one of ours" (the caller's fault).
    const { keys } = await keyStore.toJwks();
    throw keys.length === 0
      ? new TokenVerificationError("no keys available", "no_keys")
      : new TokenVerificationError("unknown kid", "key");
  }

  let result;
  try {
    result = await jwtVerify(token, publicKey, {
      issuer: options.issuer,
      audience: options.audience,
      algorithms: ["RS256"],
    });
  } catch (err) {
    throw classify(err);
  }

  const parsed = accessTokenClaimsSchema.safeParse(result.payload);
  if (!parsed.success) {
    throw new TokenVerificationError(z.prettifyError(parsed.error), "claims");
  }

  return result.payload as unknown as JwtPayload;
}
