/**
 * The client surface a token was minted for.
 *
 * Unlike roles, this has no database counterpart — there is no `channel` column anywhere in
 * db/migrations, because it describes how a session was established rather than anything about the
 * user. It is carried in the token so downstream policy can distinguish a mobile session from a
 * server-to-server one without a lookup (for example: refusing a destructive admin action from a
 * long-lived `api` token, or applying a different session lifetime per surface).
 *
 * Modelled as a const object plus a derived union rather than a TS `enum`, matching the idiom used
 * throughout packages/constants/src (see roles.ts, permissions.ts, events.ts).
 */
export const AUTH_CHANNELS = {
  /** Browser session originating from apps/web. */
  WEB: "web",
  /** Native session originating from apps/mobile. */
  MOBILE: "mobile",
  /** Machine-to-machine caller — no interactive user agent. */
  API: "api",
} as const;

export type AuthChannel = (typeof AUTH_CHANNELS)[keyof typeof AUTH_CHANNELS];
