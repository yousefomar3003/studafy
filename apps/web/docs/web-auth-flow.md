# Web auth flow

How a Studafy **web** browser session is established and maintained. The moving parts:

| Layer         | File(s)                                             | Responsibility                                                                                        |
| ------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Session store | `src/lib/auth/session-store.ts`                     | In-memory access-token lifecycle, status machine, single-flight rotation, proactive timer             |
| Wire client   | `src/lib/auth/api.ts`                               | Cookie-authenticated `refresh` / `logout` against the backend (separate from the bearer `api` client) |
| React wiring  | `src/lib/auth/context.tsx`                          | `AuthProvider`, `useAuthStatus`, `useAuth`, `useOAuthLogin`                                           |
| Guard         | `src/lib/auth/require-auth.tsx`                     | Route guard for authenticated groups (`/portal`, `/account`, …)                                       |
| Auth pages    | `src/routes/auth/LoginPage.tsx`, `CallbackPage.tsx` | Sign-in entry and the OAuth return hop                                                                |
| Return-to     | `src/lib/auth/return-to.ts`                         | Deep-link restoration across the full-page OAuth trip                                                 |
| Wiring        | `src/app/providers.tsx`                             | Builds the app-wide store; feeds it to `AuthProvider` and the realtime handshake                      |

Backend contract (see `apps/api/src/modules/auth/`):

- `GET /api/auth/oauth/google/start` (and `/microsoft/start`) — browser-redirect OAuth start. No
  channel parameter; the flow is web-only (`channel: "web"` is hardcoded at the callback).
- `GET /api/auth/oauth/{provider}/callback` — issues a token pair, writes the **HttpOnly refresh
  cookie**, and 302s to the frontend `/auth/callback`.
- `POST /api/auth/refresh` — rotates the refresh cookie. Web sessions send no body; the cookie is
  the credential. Answers `400` when nothing was presented (no session) and `401` when the
  presented credential is dead (revoked/reused/expired). Returns `access_token`, `expires_in`,
  `session_id` — no `refresh_token` for web.
- `POST /api/auth/logout` — revokes the presented family and clears the cookie; always answers
  `200`, even when nothing was presented.

## Session lifecycle

The access token lives **in memory only** — never localStorage, sessionStorage, or a cookie. The
refresh token is HttpOnly: JavaScript can present it (via the cookie) but never read it (see
`apps/api/src/modules/auth/delivery.ts` and `docs/security/web_defense_matrix.md`). The code audit
test `session-store.test.ts` locks the storage behavior in.

Status machine (`restoring | authenticated | unauthenticated | expired`):

- `restoring` — no check has run yet, or a first-time check is in flight. Guards render a loader.
- `authenticated` — an access token is held.
- `unauthenticated` — refresh answered `400` (no cookie): a fresh visitor.
- `expired` — refresh answered `401`: the session died mid-life, so the UI can say so.

**Lazy restore.** Nothing is checked until a guard or an authenticated request first asks for a
token (`restore()` / `getToken()`). A public page load never rotates the cookie.

**Single-flight rotation.** Every rotation goes through one shared in-flight request; concurrent
callers get the same promise. The backend burns each presented refresh token and denylists the
family on reuse, so concurrent rotations are never allowed to race.

**Proactive + reactive rotation.** A timer armed from `expires_in` minus a safety margin
(`refreshMarginMs`, default 60s) rotates before expiry. `getToken()` also rotates reactively when
the held token is stale — this covers throttled background tabs where timers run late. A request
never blocks on a rotation: within the margin, `getToken()` serves the current token while rotating
in the background.

**Background rotations never blank the UI.** `rotate()` only flips to `restoring` when nothing is
held (a first-time check). With a token in hand it stays `authenticated` until the outcome is
known, so the guarded UI isn't swapped for a loader every ~14 minutes.

**Failure handling** (deliberate):

- `400` → `unauthenticated` — nothing to re-authenticate.
- `401` → `expired` — the session is gone; sign in again.
- transient (429/5xx/network) with a still-valid token → keep serving it, retry on the next token
  demand. The timer is never re-armed after a failure, so a persistent outage cannot hammer a
  rate-limited endpoint in a tight loop.

## Route guarding and the return-to round trip

`RequireAuth` wraps the authenticated route groups in `src/app/routes.tsx`. On entry it asks the
store to check the cookie (`restore()` is single-flight, so several guards never double-rotate) and
renders a loader until the check resolves — a deep link with a live cookie must not flash the login
page. Once resolved:

- `authenticated` → guarded content renders.
- `unauthenticated` / `expired` → the current route (path + search) is saved via `setReturnTo`
  (sessionStorage, **path-only**, validated to be internal — no open redirect; see
  `src/lib/auth/return-to.ts`), then the browser is sent to `/auth/login`, with
  `?reason=expired` when the session died mid-life.

The redirect is a `useEffect`, not a render branch, because `restore()` is async — on the first
render there is no answer yet, so a branch would redirect before the check runs.

The full round trip for a deep link:

1. User opens `/account/billing` signed out → `RequireAuth` saves the path and redirects to
   `/auth/login`.
2. `LoginPage` re-checks the cookie (recovers a still-live session if present) and, when signed
   out, shows the provider buttons.
3. `useOAuthLogin("google")` navigates the **whole page** to `/api/auth/oauth/google/start`. A
   full-page navigation is required — the flow carries state across origins, and it is what makes
   the return-to live in `sessionStorage` rather than in memory.
4. After the exchange the API writes the refresh cookie and 302s to `/auth/callback`.
5. `CallbackPage` calls `restore()`, then `consumeReturnTo()` and navigates back to
   `/account/billing`. With no pending return-to it falls back to `/portal`.

A session that expires while the user is on the page surfaces on the next guarded entry — the
guard's `restore()` re-checks the cookie, the refresh answers `401`, and the user is routed to the
login page with the expired-session notice.

## The two API clients

`lib/auth/api.ts` deliberately builds a _separate_ anonymous client for refresh and logout:

- they are authenticated by the HttpOnly cookie, not an access token, and they are reached exactly
  when the access token is gone;
- running them through the bearer client would be a refresh-via-refresh loop (its interceptor
  resolves the token by calling the store, which refreshes via this very endpoint);
- the client sets `credentials: "include"` so the browser attaches the cookie across origins.

The bearer `api` client in `lib/api.ts` reads the store through its `getToken` seam
(`sessionStore.getToken()`), which transparently rotates first when stale.

## Realtime

The socket client (`src/app/providers.tsx`) authenticates with the same access token:
`getToken: () => store.getToken()`. Signed out, it stays `unauthorized` and never dials the
gateway. Note that a socket created before sign-in does not retry once a session appears — a
realtime follow-up (tracked separately) should reconnect on the `authenticated` transition.

## Logout

`store.logout()` calls `POST /api/auth/logout` (server revokes the family and clears the cookie)
and always clears the in-memory token and drops to `unauthenticated`, even when the network call
fails — a logged-out browser must never be left "authenticated".
