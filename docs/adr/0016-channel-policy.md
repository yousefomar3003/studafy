# ADR-016: Channel policy — the surface a session was made on is a security property

## Status

Accepted

## Context

A Studafy session can be established from three very different clients: a browser (`web`), a native
mobile app (`mobile`), and a machine-to-machine caller (`api`). They have different threat models —
a browser can be scripted by an XSS payload; a native client can read its own tokens; a long-lived
`api` token is unattended and can be exfiltrated without anyone noticing. The access token already
had to prove "who can do this" (roles, ADR-0002); this decision adds the second question the
routing layer must answer: _how_ the session was established, so a policy can distinguish, for
example, a destructive admin action from a mobile session from the same action from a browser
session. Without a channel concept, every route has to guess from user-agent sniffing or a header —
both of which a caller can forge.

## Decision

- **Channels are a closed vocabulary: `AUTH_CHANNELS = { WEB: "web", MOBILE: "mobile", API: "api" }`.**
  Defined in `apps/api/src/modules/auth/channels.ts` as a **const object + derived union** — the
  same idiom `packages/constants/src` uses for roles and permissions — and mirrored in the database
  as the `app.auth_channel` enum (000029). `packages/db/tests/identity.test.ts` asserts the two
  lists match label-for-label, so they cannot drift apart silently.
- **The channel is a property of the session, fixed at login, and never readable from a request.**
  The database stores it on `app.refresh_tokens.channel` at session establishment and copies it
  unchanged onto every child token as the family rotates (000029). Rotation reads the row, never a
  header — otherwise a client could ask for a web session's token in the response body and defeat
  `HttpOnly` (SAD_13, "Delivery"). The access token carries the same value as a claim, so downstream
  policy can distinguish surfaces with no lookup.
- **Delivery depends on the channel.** `web` sessions deliver the refresh token only via
  `Set-Cookie` (`HttpOnly; Secure; SameSite=Strict; Path=/api/auth`) and never in the body; `mobile`
  and `api` sessions deliver it in the response body, because a native client has no `document.cookie`
  and needs the token for its OS keychain (SAD_13).
- **Routes can be limited by channel with a guard.** `requireChannel(...)` middleware
  (`apps/api/src/middleware/channelGuard.ts`) refuses a request when the caller's session channel is
  not in the allowed set, answering with `ERROR_CODES.CHANNEL_NOT_AUTHORIZED` — a _distinct_ code
  from `AUTHZ_FORBIDDEN`, so monitoring and clients can tell a channel-policy denial from a
  role-based one. It runs inside the auth boundary, after `jwtAuth` established identity, and is the
  same factory shape as `requirePermission` in `authz.ts`.
- **The primary use case is web-only admin mutations.** Administrative routes that should only be
  reachable from an interactive browser session are mounted behind `requireChannel(WEB)` (e.g. the
  imports routes). The channel check is orthogonal to roles: an `ORG_ADMIN` on a `mobile` or `api`
  token holds every permission the role grants, but the channel policy still refuses the route
  because the threat model is the token surface, not the role.

## Alternatives considered

- **No channel concept — trust the role alone** — an `api` token silently gains the same destructive
  power as a browser session, and there is no vocabulary to express "web-only admin". Rejected.
- **Read the channel from a request header** — trivially forgeable and defeats `HttpOnly` (the
  attacker-era obvious move); every security artifact in SAD_13 and 000029 exists to make this
  impossible. Rejected explicitly.
- **Separate long-lived API keys instead of a channel claim** — a different credential type adds a
  second auth mechanism; the channel claim reuses the existing token and lets the _same_ user have a
  less-privileged session on a different surface. Rejected as redundant machinery.
- **Per-surface audiences in the JWT only** — audiences prove the token was _intended_ for a
  surface but are not enforced on delivery path or routes; the database channel column is what makes
  the property durable and enforceable (000029). The claim and the column are both part of the
  decision.

## Consequences

- Adding a new client surface (e.g. a desktop app) is a coordinated change: a new `AUTH_CHANNELS`
  value, its delivery path, a DB enum migration, and a parity-test update — it is a vocabulary
  change, not a per-route flag.
- A user can be logged in on several surfaces at once, and each session is independently revocable
  (SAD_13), because the channel rides each session family rather than the user.
- Route policy syntax is now two axes: "may this role do this" (`requirePermission`) and "may this
  surface reach this route" (`requireChannel`) — matching the two questions the paper threat model
  asks, with distinct error codes.

## Review

Reviewed by `baderalhindi` on 2026-09-11.
