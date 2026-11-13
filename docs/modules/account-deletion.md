# Account deletion and retention

Self-service account deletion, required by App Store Review Guideline 5.1.1(v) and Google Play's
data-deletion policy. Code: `apps/api/src/modules/account`.

## Entry points

| Platform      | Where                                                                          |
| ------------- | ------------------------------------------------------------------------------ |
| Web           | Account settings → Delete account (`/account/delete`, `DeleteAccountPage.tsx`) |
| iOS / Android | Profile → Account → Delete my account (`delete_account_screen.dart`)           |
| No login      | Public `/legal/delete-account` (the URL for Play's Data Safety form)           |

The web and mobile paths call `POST /api/account/deletion`. The no-login path ends in the same
`scheduleAccountDeletion()` call — see [Web deletion flow](#web-deletion-flow-no-sign-in).

The mobile screen is deliberately hard to use by accident: the button enables only after the
person ticks an acknowledgement, types the confirmation word (`DELETE` / `حذف`) and — for accounts
that sign in with a member ID and password — enters both, which the API verifies
(`AccountProfile.deletion_requires_member_credentials`). A wrong password counts toward the normal
sign-in lockout. A final dialog follows.

The school admin additionally has **"Delete school"**, which is _not_ an account deletion:
`POST /api/schools/current/closure` archives the school, signs every member out and blocks sign-in
(`apps/api/src/modules/tenancy/closure`). The workers' daily tenant-closure sweep then exports the
school's data and erases it 30 days after the export completes (`closure-sweep.ts`), as for a school
whose subscription closed.

## What happens

Deletion has a **14-day grace period** (migration 000143).

**Scheduling** — one transaction (`account-deletion-service.ts`):

1. Refused with `409` if a deletion is already scheduled or an erasure is already in flight.
2. Member-password accounts must send their own `member_id` and `password` on the signed-in path
   (`422 ACCOUNT_DELETION_VERIFICATION_FAILED` otherwise; `403 AUTH_ACCOUNT_LOCKED` once locked).
3. `users.deletion_requested_at` / `deletion_due_at` (now + 14 days) are set, and an `update` audit
   entry records `event: account_deletion_scheduled`, the due date and `source`.

After commit every session is revoked and its access tokens denylisted (audit reason
`account_deletion`). The response carries `scheduled_for`, `completes_by` (due date + the 30-day
erasure SLA) and `retained_records`.

**Grace period** — signing in again mints an access token with the `deletion_pending` claim
(`session-service.ts`). `accountDeletionGuard` (`apps/api/src/middleware/account-deletion-guard.ts`)
answers every other request with `403 ACCOUNT_DELETION_SCHEDULED`, allowing only
`GET /api/account/profile` (which returns `deletion_scheduled_for`), `DELETE /api/account/deletion`
and logout. The mobile app (`deletion_pending_screen.dart`) and the web
(`DeletionPendingGate.tsx`) show only "Cancel deletion" and "Sign out". Cancelling clears both
columns (audited as `account_deletion_cancelled`); the client then refreshes its token.

**On the due date** — the maintenance worker's daily account-deletion sweep (09:00 UTC,
`apps/workers/src/queues/maintenance/account-deletion-sweep.ts`), per account in one transaction:

1. AI add-on billing stops for the user's student record: Stripe subscriptions are set to cancel at
   period end; Tap subscriptions lose their saved card, so the renewal worker cannot charge them.
   A Stripe failure rolls the account back to retry the next day. App-store purchases follow —
   see [Store subscriptions](#store-subscriptions-app-store-and-google-play).
2. The user is detached from the school: `users.status = 'archived'`, and their `user_roles`,
   `oauth_identities` and `parent_child_links` (as parent) are deleted; any open session is revoked.
   With no identity row and no roles, no login or refresh can succeed.
3. An `erasure` row is filed in `app.data_subject_requests` (due in 30 days), with an `update`
   audit entry on `users` (request id, due date, cancelled subscriptions).
4. An `account.deleted` outbox event is written when the account has an email address; the email
   dispatcher sends the confirmation (school, erasure date, what is kept) from it.

After commit the erasure job is enqueued. A failed account stays due and is retried the next day.

## Store subscriptions (App Store and Google Play)

Students buy the AI add-on in the mobile app (web purchase is switched off). Apple and Google
bill those subscriptions, not Studafy, so deleting the account cannot simply stop them:

| Store       | What deletion does                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Store   | Nothing — Apple has no API for a developer to cancel a subscription. The person must cancel it in Settings → their name → Subscriptions.                                                                                     |
| Google Play | On the due date, the sweep turns off renewal (`purchases.subscriptions.cancel`, `google-play-ai-billing-canceller.ts`), **best-effort**: a failure or missing credentials is logged and recorded, never blocks the deletion. |

A store purchase has no provider column on `ai_subscriptions`; its billing event names the store and
purchase token, read through `app.ai_store_purchases()` (000163) — the same lookup licensing uses
when a school seat covers a personal subscriber. The deletion's audit entry records one
`store_subscriptions` item per store purchase: `{ platform, outcome }`, with outcome `canceled`,
`not_renewing` (Play says it will not renew anyway), `failed`, `not_configured` (no Play
credentials on the workers) or `not_cancellable` (App Store).

**Warning before deletion.** Because neither path is guaranteed, the person is told up front.
`GET /api/account/profile`, `POST /api/account/deletion` and each account in the emailed-link
confirm response carry `active_store_subscriptions`: one `{ platform, for_child }` item per store
and owner, for live (`LIVE_STATUSES`, period not ended) AI add-ons bought in a store, on the
caller's own student record **and on every student linked to them as a parent** — a parent's
deletion cancels nothing for their children, whose accounts stay. It names no child and no
subscription detail. When it is not empty, the screens show the store's cancel steps:

- web `DeleteAccountPage.tsx` (before the action and again once scheduled) and
  `DeletionPendingGate.tsx` (during the grace period), through `StoreSubscriptionWarning.tsx`;
- mobile `delete_account_screen.dart` (`StoreSubscriptionWarningCard`, above the form);
- the public `/legal/delete-account/confirm` page, after confirming; before it, its text and the
  `/legal/delete-account` page say so for everyone.

**Configuration.** The workers need `GOOGLE_PLAY_PACKAGE_NAME` and `GOOGLE_PLAY_SERVICE_ACCOUNT`
(the same values as the api; set together). Without them the Play call is skipped with a warning.

Within 30 days, the maintenance worker's erasure pass
(`apps/workers/src/queues/maintenance`) redacts personal-data columns across the tenant's tables
and deletes session/identity artefacts, per `retention-registry.ts`. Before that walk it erases what
the person wrote themselves (`authored-content-dsr.ts`, `AUTHORED_CONTENT_TABLES`):

- **Messages they sent** (`messages.sender_user_id`): the body becomes `[deleted]`; the row stays so
  the other participant's thread keeps its shape. Their images (`message_attachments`) are deleted,
  and the stored objects removed after the transaction commits. The `DIRECT_MESSAGE` notification
  each message raised for the recipient quotes it, so that preview becomes `[deleted]` too.
- **Their AI study content** (a student's): Ask AI conversations, questions, answers and citations,
  quizzes, flashcard decks with cards and review schedule, and practice exams with items and
  answers are deleted. `ai_moderation_decisions.message_id` is cleared; the decision (a hash, never
  the text) stays. Summaries and concept maps exist only in a 24-hour Redis cache, which has expired
  by the end of the 14-day grace period; Ask AI never stores the photos it reads.
- **Kept for safeguarding:** a message an open report (`pending`/`in_review`) points at, directly or
  in its snapshot, is left exactly as it is, with its images; an image any report's snapshot points
  at is kept; the snapshots (`message_report_messages`) and AI content reports
  (`ai_content_reports`, with their `content_snapshot`) are the school's record. Each is listed in
  the request's `retained_tables`, with counts for the messages and images.

A school closure's erasure applies the same rules to everyone in the school.

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
   - The address is resolved again, and each account goes through `scheduleAccountDeletion()` with
     `source: "web_request"`: the same 14-day schedule, audit entry and session revocation as a
     deletion from account settings. The emailed link is the proof of ownership, so no member ID
     or password is asked for.
   - The token is deleted only after every account succeeded. A failure part-way leaves it valid,
     and a retry skips the accounts already scheduled.
3. The page lists each school with its deletion date, its erasure date and the retained records
   from `retention-policy.ts`.

Both endpoints are unauthenticated, CSRF-exempt (no ambient credential to forge), and in the
`auth-strict` rate-limit class. `deletion-request-routes.test.ts` pins that they stay reachable
without a session while `POST /api/account/deletion` stays protected.

**Audit.** An unconfirmed request writes nothing to any school's audit log: until the link is
used it is anonymous input, and auditing it would let anyone write rows into any school's log. It
is logged (`account_deletion_request_sent` / `_no_account`, without the address). The confirmed
deletion is the audited event, one `update` row (`event: account_deletion_scheduled`) per account
with `source: "web_request"`.

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

Also kept, and disclosed in the privacy policy (section 11.3) rather than in `retained_records`: work
handed in to teachers (`assignment_submissions`, `submission_attachments`), discipline records and
other school records, and safeguarding reports with the messages they hold (above). Messages the
person sent and their AI study content are erased.

The retention _period_ for grades and attendance is set by each school's education authority and
is not encoded here.

Data Studafy deletes on a fixed schedule regardless of any request (AI chats, sensitive record
fields, imports, reports, notifications, security events, rejected applications, export bundles)
is listed in [data-retention.md](./data-retention.md).

## IP addresses

**Rule: an IP address is kept for 90 days, then removed (set to NULL), everywhere an `UPDATE` is
allowed. The audit log is the one exception.** The row stays; only the address goes. This applies to
every account, deleted or not.

| Where                                   | Column       | After 90 days                                                                                                |
| --------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `app.refresh_tokens` (sessions; tenant) | `ip_address` | Set to NULL, per school                                                                                      |
| `app.security_events` (global)          | `client_ip`  | Set to NULL                                                                                                  |
| `app.audit_logs` (append-only)          | `client_ip`  | **Kept for the audit log's lifetime** — no `UPDATE` is possible (grants + trigger), and that is not weakened |
| Redis rate-limit buckets                | key name     | Expire on their own within about 2 minutes (below)                                                           |

**Mechanism.** `apps/workers/src/queues/maintenance/ip-address-retention-sweep.ts`, job
`purge-expired-ip-addresses` on the maintenance queue, daily at 03:45 UTC
(`ip-address-retention-sweep-scheduler.ts`). Rows are updated 1000 per statement, one transaction per
batch, `FOR UPDATE SKIP LOCKED`: `refresh_tokens` per school under `withSystemTenantTx` (served by the
partial index `idx_refresh_tokens_school_ip_created`, 000193), `security_events` once as
`studafy_admin`. A school that fails is logged and skipped; the rest continue. Age is the row's
`created_at`. Neither column is in a CHECK constraint or watched by an `UPDATE` trigger.

**Audit log.** `app.audit_logs` is append-only by grant and by `trg_audit_logs_append_only`, for the
owner too (`docs/database/audit-log-partition-maintenance.md`). Its `client_ip` therefore lives as long
as the row, and the audit log currently has no automatic retention. The Privacy Policy says so.

**Redis rate-limit keys.** IP-scoped buckets (`rl:{class}:{ip}:{window}`, and `rl:sch:{ip}:…` for an
unauthenticated request on a user-scoped route) are written by `takeRateLimitToken` with
`SET … EX ttl` on every hit, `ttl = windowSeconds + ceil(maxTokens / refillRate)`. With the budgets in
`apps/api/src/config/rateLimits.ts` that is at most 123 s (`auth-strict`: 60 + ⌈5 / 0.08⌉). The only
longer-lived buckets, member sign-in `username` (up to 30 minutes), are keyed by member ID, not IP.

**Not covered here.** Application logs (Axiom), Sentry and Cloudflare Turnstile follow those
providers' retention; they are listed separately in the Privacy Policy.

## Known gaps

Stated plainly so they are not mistaken for done:

- **Sign in with Apple is not implemented.** Studafy has no Apple login and stores no Apple tokens,
  so there is nothing to revoke. `apple-token-revoker.ts` implements Apple's `/auth/revoke` call
  (ES256 client secret), unit-tested against a stub but never against Apple. When SIWA login is
  built it must persist the refresh token Apple returns (encrypted) and revoke it in the worker's
  account-deletion sweep, before the identities are removed. Until then, App
  Store guideline 4.8 (offer SIWA alongside Google/Microsoft) remains the open item in
  `apps/mobile/store/review-checklist.md`.
- **A message kept for an open report is not erased later.** Once the report is closed, nothing
  re-runs the erasure for it; it stays until the school deletes it or closes. A notification title
  that names the sender (`DIRECT_MESSAGE` and other types) is not rewritten either; only the
  message preview in its body is.
- **Submission text and files stay by design** (`assignment_submissions.content`,
  `submission_attachments`): they are work handed in to the school, not erased with the account.
- **AI subscriptions are matched through the student record.** A parent deleting their account
  does not cancel a child's AI subscription they may be paying for; `ai_subscriptions` has no payer
  column to match on. The parent is warned (`active_store_subscriptions` with `for_child: true`)
  and given the store's steps, since the child's account stays.
- **App Store subscriptions cannot be cancelled by Studafy**, and the Google Play cancel is
  best-effort. Only the warning above covers them; a `failed` outcome on the audit entry is not
  retried.
- **School closure stops no AI add-on billing at all** (Stripe, Tap or store). The closure sweep
  (`closure-sweep.ts`) files the tenant export and erasure only, and there is no screen to warn
  students and parents on. Terms 7.10 tells them to cancel in the store.
- **The web flow trusts mailbox control.** Anyone who can read an account's email can delete it —
  the same trust the invitation flow places in that mailbox. An account whose school recorded an
  address the person no longer controls can only be deleted by signing in or through the school.
- **The web request's response time can differ** between an address with accounts (Redis write +
  outbox insert) and one without. The response body and status do not. The cooldown and rate limit
  bound how fast this can be probed; it is not constant-time.
- **An account with an erasure already pending from `POST /api/privacy/me/dsr`** is not archived,
  so the web confirm resolves it and `scheduleAccountDeletion()` answers `409 DSR_ALREADY_PENDING`. The
  page shows that message; the pending erasure still runs.
- **A pending session can still open a realtime connection.** `accountDeletionGuard` covers the
  API only; the realtime service ignores the `deletion_pending` claim, though it can only deliver
  events, not act.
- **The worker's due-date sweep does not use the API's access-token denylist.** Sessions were
  already revoked when the deletion was scheduled; an access token minted during the grace period
  carries `deletion_pending`, so it stays confined until it expires on its own TTL.
- **`POST /api/privacy/me/dsr` with `request_type: "erasure"` still exists.** It files the erasure
  without the immediate sign-out, detach or billing stop. The web app no longer calls it for
  deletion.
