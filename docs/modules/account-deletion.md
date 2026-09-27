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

All three in-app paths call `POST /api/account/deletion`.

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
   revoked SIWA tokens and retained categories.
6. The erasure job is enqueued. If that fails, everything above rolls back and the user, still
   signed in, can retry.

After commit, every session is revoked and its access tokens denylisted (audit reason
`account_deletion`). A failure here is logged, not returned: the account is already unusable, and
an access token then lasts at most `JWT_ACCESS_TTL_SECONDS`.

Within 30 days, the maintenance worker's erasure pass
(`apps/workers/src/queues/maintenance`) redacts personal-data columns across the tenant's tables
and deletes session/identity artefacts, per `retention-registry.ts`.

The response carries `completes_by` and `retained_records`, which the web page shows as the
confirmation.

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
- **`POST /api/privacy/me/dsr` with `request_type: "erasure"` still exists.** It files the erasure
  without the immediate sign-out, detach or billing stop. The web app no longer calls it for
  deletion.
