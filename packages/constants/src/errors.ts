/**
 * Typed, unique error codes shared across services. Uniqueness of values (not just keys) is
 * enforced by a unit test — see errors.test.ts.
 */
export const ERROR_CODES = {
  // Authentication — identity of the caller could not be established.
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  AUTH_TOKEN_EXPIRED: "AUTH_TOKEN_EXPIRED",
  AUTH_TOKEN_INVALID: "AUTH_TOKEN_INVALID",
  AUTH_SESSION_NOT_FOUND: "AUTH_SESSION_NOT_FOUND",

  // Invitation verification — public invitation lifecycle resolution.
  INVITATION_INVALID: "INVITATION_INVALID",
  EXPIRED: "EXPIRED",
  REVOKED: "REVOKED",
  CONSUMED: "CONSUMED",
  SCHOOL_SUSPENDED: "SCHOOL_SUSPENDED",

  // OAuth — external identity provider flow.
  OAUTH_STATE_INVALID: "OAUTH_STATE_INVALID",
  OAUTH_EMAIL_NOT_VERIFIED: "OAUTH_EMAIL_NOT_VERIFIED",
  OAUTH_PROVIDER_ERROR: "OAUTH_PROVIDER_ERROR",

  // Account activation — the OAuth identity diverged from the invitation's bound email, so
  // automatic provisioning is withheld pending an administrator's decision.
  REQUIRES_ADMIN_APPROVAL: "REQUIRES_ADMIN_APPROVAL",

  // Authorization — caller is known, but not permitted.
  AUTHZ_FORBIDDEN: "AUTHZ_FORBIDDEN",
  AUTHZ_ROLE_NOT_FOUND: "AUTHZ_ROLE_NOT_FOUND",
  AUTHZ_PERMISSION_NOT_FOUND: "AUTHZ_PERMISSION_NOT_FOUND",

  // Validation — caller input was malformed.
  VALIDATION_FAILED: "VALIDATION_FAILED",
  VALIDATION_REQUIRED_FIELD_MISSING: "VALIDATION_REQUIRED_FIELD_MISSING",

  // Resource — the requested entity does not exist or was already removed.
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
  RESOURCE_ALREADY_DELETED: "RESOURCE_ALREADY_DELETED",

  // Conflict — the request contradicts current server state.
  CONFLICT_DUPLICATE_ENTRY: "CONFLICT_DUPLICATE_ENTRY",
  CONFLICT_STATE_MISMATCH: "CONFLICT_STATE_MISMATCH",
  CONFLICT_IDEMPOTENCY_KEY_MISMATCH: "CONFLICT_IDEMPOTENCY_KEY_MISMATCH",

  // Rate limiting.
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",

  // Uncategorized server-side failure.
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
