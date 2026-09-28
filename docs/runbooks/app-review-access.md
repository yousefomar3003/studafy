# App Store and Google Play reviewer access

Apple App Review and Google Play review sign in to the production build as each role, using an
email and password rather than a Microsoft or Google account. Those accounts belong to one demo school, the
**reviewer tenant**, which is isolated from real schools and cannot be billed (ST-303).

- Seed: [`db/seeds/review-tenant.ts`](../../db/seeds/review-tenant.ts) (`bun run db:seed:review`)
- Roster and logins (source of truth for the table below):
  [`db/seeds/review-credentials.ts`](../../db/seeds/review-credentials.ts)
- Login: `POST /api/auth/login/review`
  ([`review-login-service.ts`](../../apps/api/src/modules/auth/services/review-login-service.ts))
- Schema: [`db/migrations/000115_add_review_tenant.sql`](../../db/migrations/000115_add_review_tenant.sql)

## Accounts

School: **Studafy Review Academy** (slug `studafy-review-academy`)

| Role          | Email                         | Who they are                                    |
| ------------- | ----------------------------- | ----------------------------------------------- |
| Administrator | `admin@review.studafy.test`   | Omar Haddad, school administrator (`ORG_ADMIN`) |
| Teacher       | `teacher@review.studafy.test` | Layla Nasser, Science teacher (`INSTRUCTOR`)    |
| Parent        | `parent@review.studafy.test`  | Rania Khalil, mother of Yara Khalil (`PARENT`)  |
| Student       | `student@review.studafy.test` | Yara Khalil, enrolled in Science (`STUDENT`)    |

All four use the same password: the `REVIEW_LOGIN_PASSWORD` secret. **The password is never
committed to this repository.** It lives in the secret manager and is typed into App Store Connect
and the Play Console only.

The addresses are on the reserved `.test` domain. No inbox exists, and every address is on
`app.email_suppressions`, so the platform never sends them mail. The rest of the roster (two more
teachers, a teaching assistant, seven more students, five more parents) exists so the school looks
real. Those accounts have no login.

## Seeded data

The seed runs the same data modules as the local demo seed (`db/seeds/data/*`). It writes:

- an academic year with terms, subjects, courses, and rooms;
- Science and Math classes with enrollments (Yara is in Science);
- an approved timetable and attendance sessions with records;
- assignments with submissions, an exam with results, gradebooks, and grades;
- course materials with AI retrieval chunks, and AI tutor conversations with citations;
- invoice, payment, and fee-schedule records;
- in-app notifications for students, and audit-log entries.

Everything is dated in the 2025–26 academic year (July 2026). See Known limitations.

## Provisioning (once per environment)

1. **Apply migrations.** `000115_add_review_tenant.sql` must be applied (`bun run db:migrate`).
2. **Set the password.** Generate a value of at least 16 characters (use 24 or more; the API refuses
   to boot with a shorter one) and add it to the API's application secrets as
   `REVIEW_LOGIN_PASSWORD`. Follow
   [`secrets-conventions.md`](./secrets-conventions.md), container `<name_prefix>/api/app-secrets`:

   ```bash
   export TF_VAR_secrets_app_secret_values='{"api":{"REVIEW_LOGIN_PASSWORD":"<generated value>"}}'
   terraform apply -var-file=environments/<env>/<env>.tfvars
   ```

   (Merge with the existing `api`/`realtime` keys; the variable replaces the whole map.) As
   `secrets-conventions.md` notes, injecting secrets into the running API is not wired end-to-end
   yet. Until it is, set the variable wherever the API's production environment is defined. While
   `REVIEW_LOGIN_PASSWORD` is unset, `POST /api/auth/login/review` answers 404.

3. **Seed the tenant**, using the migration/admin database credentials:

   ```bash
   REVIEW_TENANT_SEED_CONFIRM=studafy-review-academy bun run db:seed:review
   ```

   Without the confirmation variable the seed refuses to run. If the tenant already exists it
   writes nothing and exits 0, so it is safe to run on every release.

4. **Verify** each account against the production API:

   ```bash
   curl -s -X POST https://<api-host>/api/auth/login/review \
     -H 'content-type: application/json' \
     -d '{"email":"teacher@review.studafy.test","password":"<password>","channel":"mobile"}'
   ```

   Expect `200` with `access_token`. A `401 AUTH_INVALID_CREDENTIALS` means a wrong password or a
   missing tenant. A `404` means the secret is not set.

## App Store Connect: App Review Information

_App Store Connect → your app → the version → App Review Information._ Tick **Sign-in required**
and fill **User name** / **Password** with the Administrator account. Paste into **Notes**:

```text
Studafy is a school management app. Accounts are normally created by a school, and users sign in
with their school's Microsoft or Google account. For review, we provide a demo school with one
account per role. All four accounts use the password entered above.

On the sign-in screen, choose "Sign in with email" and use:

  Administrator: admin@review.studafy.test
  Teacher:       teacher@review.studafy.test
  Parent:        parent@review.studafy.test
  Student:       student@review.studafy.test

The Parent account is the parent of the Student account. The demo school is non-billable, so
subscription checkout is disabled in it. The addresses are placeholders and do not receive email.
```

## Google Play Console: App access

_Play Console → your app → Policy and programs → App content → App access._ Choose **All or some
functionality is restricted** and add one instruction set per role:

| Name          | Username / email              | Password     | Any other information                                    |
| ------------- | ----------------------------- | ------------ | -------------------------------------------------------- |
| Administrator | `admin@review.studafy.test`   | `<password>` | Tap "Sign in with email". School administrator.          |
| Teacher       | `teacher@review.studafy.test` | `<password>` | Tap "Sign in with email". Science teacher.               |
| Parent        | `parent@review.studafy.test`  | `<password>` | Tap "Sign in with email". Parent of the Student account. |
| Student       | `student@review.studafy.test` | `<password>` | Tap "Sign in with email". Student enrolled in Science.   |

Tick **Allow Android to use the credentials you provide for performance and app compatibility
testing** only if that is acceptable. Those automated runs sign in as these accounts and may change
data.

## Verified flows

Checked against a freshly migrated and seeded database, through the real API stack (auth, RLS,
channel guards), following the same calls the mobile screens make:

- **Administrator**: active year and term, classes, the approved timetable.
- **Teacher**: own profile (`/api/teachers/me`), their Science class, its 5 enrolled students, the
  gradebook, assignments, attendance sessions.
- **Parent**: child comparison for the current term, family finance (invoices), notifications.
- **Student**: timetable, assignments, materials, notifications (2).

## Isolation and safety guarantees

| Guarantee                                               | Enforced by                                                                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The password works only for the reviewer tenant         | Login resolves `(review, email)` and refuses unless that school has `is_review_tenant`; real users never have a `review` identity. |
| Wrong password, unknown email, other school: same reply | One `401 AUTH_INVALID_CREDENTIALS`; password check and identity lookup always both run.                                            |
| Brute force is rate-limited                             | `/api/auth/login/review` is `auth-strict` (5 burst, about 5/min per IP).                                                           |
| No platform-wide access                                 | The roster has no `SUPER_ADMIN`.                                                                                                   |
| Never billed                                            | Checkout returns `403 REVIEW_TENANT_BILLING_DISABLED` before any provider call. A DB CHECK forbids Stripe/Tap customer ids.        |
| Not offered as a plan                                   | Its plan `review_demo` is inactive and has no price.                                                                               |
| At most one reviewer tenant                             | Partial unique index `uq_schools_review_tenant`.                                                                                   |
| No outbound email                                       | All tenant addresses are suppressed (`reason = 'review_tenant'`).                                                                  |
| No fake push tokens or pending domain events            | The review profile skips the local-only device and outbox fixtures.                                                                |
| Not creatable by the local seed                         | `bun run db:seed` seeds only the local demo profile (`is_review_tenant = false`), and its own guard refuses production hosts.      |
| Login can't be unlinked                                 | Provider unlinking accepts only `microsoft` / `google`.                                                                            |
| Post-login behaviour                                    | Same path as OAuth login: suspension policy, `last_login_at`, audit row (`provider: review`), and session tokens.                  |

## Rotating the password

Change `REVIEW_LOGIN_PASSWORD` and redeploy the API. Then update App Store Connect and the Play
Console _before_ the next submission. Existing reviewer sessions stay valid until they expire or
are revoked. To end them immediately, use the admin session revocation for each account.

## Known limitations

- **Mobile only.** The "Sign in with email" entry exists in the mobile app's login screen
  (`apps/mobile/lib/src/features/auth/presentation/login_screen.dart`). The web app has no email
  form; store review does not use it.
- **Administrator on mobile is read-only.** Admin roles get the mobile view-only shell by design,
  and admin management endpoints refuse mobile sessions (`CHANNEL_NOT_AUTHORIZED`). Reviewers see
  the school overview, not the admin console.
- **Dates are fixed.** The dataset is anchored to July 2026 (the partition window the local seed
  shares), so terms, due dates, and subscription periods appear in the past as time goes on.
  Features do not lock: entitlements are status-based. Period-filtered dashboards (for example
  AI usage metrics) will show the periods as ended.
- **Material files are not uploaded.** Material rows and their AI chunks are seeded, so lists,
  search, and AI citations work. Downloading or previewing the original PDF fails, because no
  object exists at its storage key. Upload the files to the production bucket at the seeded keys
  if reviewers need them.
- **Reviewers can change data.** The Administrator can edit or deactivate users, including the
  other reviewer accounts. There is no reset command: the seed only creates a missing tenant.
  Check the four logins (step 4) before each submission.
- **Price sync.** A manual plan/price sync pushes the inactive `review_demo` plan to Stripe as an
  archived product with no price.
