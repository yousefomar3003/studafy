/**
 * The realtime handshake contract (F-05, QA-14): what `apps/api` mints and what `apps/realtime`
 * accepts. Both sides import these values so that issuer and verifier cannot drift apart. The
 * narrative spec is apps/realtime/docs/protocol.md#handshake-ticket.
 *
 * A ticket is an HS256 JWT signed with `WS_JWT_SECRET`, a secret the API and the gateway share
 * through Secrets Manager. It is not the session's access token. It lives for seconds, can be used
 * for one handshake, and is addressed to the gateway alone (`aud`), so an access token presented to
 * the gateway, or a ticket presented to the API, is rejected.
 */
export const REALTIME_TICKET = {
  /** `iss` claim. */
  issuer: "studafy-api",
  /** `aud` claim. The API's own access tokens carry a different audience, so they never verify here. */
  audience: "studafy-realtime",
  /** Lifetime the API mints with. */
  ttlSeconds: 30,
  /** The most the gateway accepts (`exp - iat`). Anything longer-lived is refused as invalid. */
  maxTtlSeconds: 60,
  /** Clock skew the gateway tolerates on `iat` between API and gateway hosts. */
  clockSkewSeconds: 5,
} as const;

/**
 * Redis key prefix for revoked access-token ids (`jti`). Written by the API's revocation services
 * (apps/api/src/modules/auth/denylist.ts) and read by the gateway, which closes a socket whose
 * session (`sid` claim) shows up here.
 */
export const JTI_DENYLIST_PREFIX = "auth:jti:denylist:";

/** The Redis key the gateway sets to mark a ticket `jti` as spent. Expires with the ticket. */
export const REALTIME_TICKET_USED_PREFIX = "realtime:ticket:used:";
