# Account deletion and retention

Self-service account deletion, required by App Store Review Guideline 5.1.1(v) and Google Play's
data-deletion policy. Code: `apps/api/src/modules/account`.

## Entry points

| Platform | Where                                                                            |
| -------- | -------------------------------------------------------------------------------- |
| Web      | Account settings → Delete account (`/account/delete`, `DeleteAccountPage.tsx`)   |
| iOS      | Profile tab → "Delete my account", opens `/account/delete` in the system browser |
| Android  | Same as iOS                                                                      |
| No login | Public `/legal/delete-account` (the URL for Play's Data Safety form)             |

All three in-app paths call `POST /api/account/deletion`. The no-login path ends in the same
`deleteAccount()` call — see [Web deletion flow](#web-deletion-flow-no-sign-in).

## What happens

Immediately, in one transaction (`account-deletion-service.ts`):

1. Sign in with Apple tokens are revoked through `SiwaTokenRevocation` — see "Known gaps".
2. AI add-on billing stops for the user's student record: Stripe subscriptions are set to cancel at
   period end; Tap subscriptions lose their saved card, so the renewal worker cannot charge them.
3. The user is detached from the school: `users.status = 'archived'`, and their `user_roles`,
   `oauth_identities` and `parent_child_links` (as parent) are deleted. With no identity row, no
   login path can resolve the account again.
4. An `erasure` row is filed in `app.data_subject_requests` (due in 30 days).
5. A `delete` audit entry on `users` records the request id, due date, cancelled subscriptions,
   revoked SIWA tokens, retained categories and `source` (`account_settings` or `web_request`).
6. An `account.deleted` outbox event is written; the email dispatcher sends the confirmation email
   (school, erasure date, what is kept) from it.
7. The erasure job is enqueued. If that fails, everything above rolls back and the user, still
   signed in, can retry.

After commit, every session is revoked and its access tokens denylisted (audit reason
`account_deletion`). A failure here is logged, not returned: the account is already unusable, and
an access token then lasts at most `JWT_ACCESS_TTL_SECONDS`.

Within 30 days, the maintenance worker's erasure pass
(`apps/workers/src/queues/maintenance`) redacts personal-data columns across the tenant's tables
and deletes session/identity artefacts, per `retention-registry.ts`.

The response carries `completes_by` and `retained_records`, which the web page shows as the
confirmation.

## Web deletion flow (no sign-in)

Google Play requires a deletion path that works without installing the app and without signing
in. Code: `apps/api/src/modules/account/deletion-request-service.ts`,
`apps/web/src/routes/legal/`.

Accounts sign in only through Google/Microsoft, so there is no password to check. Ownership is
proved by clicking a link sent to the account's email address — the same proof the invitation flow
uses to create the account.

1. **Request** — `/legal/delete-account` → `POST /api/account/deletion-requests` with the email and
   a Turnstile token.
   - Captcha fails → `400 CAPTCHA_INVALID`.
   - A Redis cooldown key (SHA-256 of the address, 5 min, `SET NX`) is taken. If it already
     existed, stop: at most one email per address per five minutes.
   - `app.resolve_accounts_for_deletion_request()` (migration 000115) returns every non-archived
     account on that `normalized_email`, across schools. It is a SECURITY DEFINER lookup scoped to
     one transaction-local GUC, the same seam as the OAuth login resolver (000034).
   - No accounts → stop. Otherwise a 256-bit token is generated; Redis stores
     `SHA-256(token) → address` for one hour. An `account.deletionRequested` outbox event (in the
     first account's school) carries the raw token and every school name, and the dispatcher
     emails a link to `/legal/delete-account/confirm#token=…`.
   - Every non-captcha outcome answers the same `202`, so the endpoint does not reveal who has an
     account.
2. **Confirm** — the link opens a page, not an API call: mail scanners follow links on their own,
   and a GET must never delete anything. The token is in the URL fragment, which browsers never
   send to a server, and the page removes it from the address bar once read. Pressing the button
   sends `POST /api/account/deletion-requests/confirm` with the token in the body.
   - Unknown, expired, malformed or used token → `400 VERIFICATION_TOKEN_INVALID`.
   - The address is resolved again, and each account goes through `deleteAccount()` with
     `source: "web_request"`: the same transaction, audit entry, erasure job, session revocation
     and confirmation email as a deletion from account settings.
   - The token is deleted only after every account succeeded. A failure part-way (a Stripe outage,
     say) leaves it valid, and a retry picks up only the accounts not yet archived.
3. The page lists each school with its erasure date and the retained records from
   `retention-policy.ts`.

Both endpoints are unauthenticated, CSRF-exempt (no ambient credential to forge), and in the
`auth-strict` rate-limit class. `deletion-request-routes.test.ts` pins that they stay reachable
without a session while `POST /api/account/deletion` stays protected.

**Audit.** An unconfirmed request writes nothing to any school's audit log: until the link is
used it is anonymous input, and auditing it would let anyone write rows into any school's log. It
is logged (`account_deletion_request_sent` / `_no_account`, without the address). The confirmed
deletion is the audited event, one `delete` row per account with `source: "web_request"`.

**Configuration.** Needs `REDIS_URL` (else `503 DSR_UNAVAILABLE`, as for in-app deletion),
`TURNSTILE_SECRET_KEY` on the API and `VITE_TURNSTILE_SITE_KEY` on the web (without the secret, the
captcha check is skipped — development only), and `FRONTEND_URL` on the workers for the link.

## What is retained, and why

`apps/api/src/modules/account/retention-policy.ts` is the disclosure;
`apps/workers/src/queues/maintenance/retention-registry.ts` is the mechanism. A change to one is a
change to the other.

| Category            | Tables                                                         | After erasure                   | Basis                                                   |
| ------------------- | -------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| `academic_grades`   | `gradebooks`, `grade_submissions`, `grades`                    | Kept, personal columns redacted | GDPR Art. 17(3)(b), 6(1)(c): school record-keeping duty |
| `attendance`        | `attendance_records`, `attendance_record_versions`             | Kept, personal columns redacted | Same                                                    |
| `financial_records` | `subscriptions`, `ai_subscriptions`, payment and refund tables | Untouched (legal hold)          | Tax and accounting law                                  |
| `audit_log`         | `audit_logs`                                                   | Untouched (legal hold)          | Art. 5(2) accountability, incl. this deletion           |

The retention _period_ for grades and attendance is set by each school's education authority and
is not encoded here.

## Known gaps

Stated plainly so they are not mistaken for done:

- **Sign in with Apple is not implemented.** Studafy has no Apple login and stores no Apple tokens,
  so there is nothing to revoke. `apple-token-revoker.ts` implements Apple's `/auth/revoke` call
  (ES256 client secret), unit-tested against a stub but never against Apple. When SIWA login is
  built it must persist the refresh token Apple returns (encrypted) and supply a
  `SiwaTokenRevocation` to `accountRoutes` in `app.ts`, which passes `null` today. Until then, App
  Store guideline 4.8 (offer SIWA alongside Google/Microsoft) remains the open item in
  `apps/mobile/store/review-checklist.md`.
- **The erasure worker misses free text and files.** It redacts by column name and finds a
  person's rows only through `user_id`/`student_id`/`teacher_id`. So `ai_messages.question/answer`
  (keyed by `conversation_id`), submission text content, and uploaded files in S3
  (`submission_attachments`, `assignment_attachments`) are not erased. Fixing this is a worker
  change.
- **AI subscriptions are matched through the student record.** A parent deleting their account
  does not cancel a child's AI subscription they may be paying for; `ai_subscriptions` has no payer
  column to match on.
- **The web flow trusts mailbox control.** Anyone who can read an account's email can delete it —
  the same trust the invitation flow places in that mailbox. An account whose school recorded an
  address the person no longer controls can only be deleted by signing in or through the school.
- **The web request's response time can differ** between an address with accounts (Redis write +
  outbox insert) and one without. The response body and status do not. The cooldown and rate limit
  bound how fast this can be probed; it is not constant-time.
- **An account with an erasure already pending from `POST /api/privacy/me/dsr`** is not archived,
  so the web confirm resolves it and `deleteAccount()` answers `409 DSR_ALREADY_PENDING`. The
  page shows that message; the pending erasure still runs.
- **`POST /api/privacy/me/dsr` with `request_type: "erasure"` still exists.** It files the erasure
  without the immediate sign-out, detach or billing stop. The web app no longer calls it for
  deletion.
