/**
 * The client surface a token was minted for.
 *
 * Unlike roles, this says nothing about the user — it describes how a session was established. It is
 * carried in the access token so downstream policy can distinguish a mobile session from a
 * server-to-server one without a lookup (for example: refusing a destructive admin action from a
 * long-lived `api` token, or applying a different session lifetime per surface).
 *
 * It also has a database counterpart, added by ST-071:
 * `db/migrations/000029_add_refresh_token_session_columns.sql` creates `app.auth_channel` mirroring
 * this object label-for-label, and stores it on `app.refresh_tokens.channel`. (An earlier revision
 * of this comment said no such column existed anywhere, which was true until that migration.) The
 * two are not redundant: the claim records the surface a *token* was minted for, while the column
 * records the surface the *session* was established from, fixed at login and copied unchanged onto
 * every child token as the family rotates. Rotation reads the column rather than a request header,
 * so a client cannot flip a web session into body delivery and read a token out of a response that
 * was supposed to stay HttpOnly. `packages/db/tests/identity.test.ts` asserts the two lists match.
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
