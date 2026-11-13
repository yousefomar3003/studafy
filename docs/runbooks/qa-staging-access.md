# Staging QA access

QA-02 ([`docs/testing/qa-plan.md`](../testing/qa-plan.md)). Testers need a bearer token for every
role in two schools on staging, in under five minutes, without database access. Staging refuses
the mock OAuth provider (it runs `NODE_ENV=production`), so three **QA tenants** carry their own
email + shared-password login.

- Seed: [`db/seeds/qa-tenant.ts`](../../db/seeds/qa-tenant.ts) (`bun run db:seed:qa`)
- Roster and logins (source of truth for the table below):
  [`db/seeds/qa-credentials.ts`](../../db/seeds/qa-credentials.ts)
- Login: `POST /api/auth/login/qa`
  ([`qa-login-service.ts`](../../apps/api/src/modules/auth/services/qa-login-service.ts))
- Schema: [`db/migrations/000183_add_qa_tenant.sql`](../../db/migrations/000183_add_qa_tenant.sql)
- Tester tooling: [`qa/`](../../qa/README.md) (curl script and Bruno collection)

## Accounts

All use one password: the `QA_LOGIN_PASSWORD` secret. **It is never committed to this
repository.** Ask the staging owner for it, or read it from the secret manager.

| School                                            | Role                 | Email                                 | Channel  |
| ------------------------------------------------- | -------------------- | ------------------------------------- | -------- |
| Studafy QA Platform (`studafy-qa-platform`)       | `SUPER_ADMIN`        | `superadmin@qa-platform.studafy.test` | `web`    |
| Studafy QA School A / B (`studafy-qa-school-a/b`) | `ORG_ADMIN`          | `admin@qa-a.studafy.test`             | `web`    |
|                                                   | `PRINCIPAL`          | `principal@qa-a.studafy.test`         | `web`    |
|                                                   | `INSTRUCTOR`         | `layla.nasser@qa-a.studafy.test`      | `mobile` |
|                                                   | `STUDENT`            | `yara.khalil@qa-a.studafy.test`       | `mobile` |
|                                                   | `PARENT`             | `khalil.parent@qa-a.studafy.test`     | `mobile` |
|                                                   | `FINANCE`            | `finance@qa-a.studafy.test`           | `web`    |
|                                                   | `ATTENDANCE_OFFICER` | `attendance@qa-a.studafy.test`        | `mobile` |

School B uses the same addresses on `qa-b.studafy.test`. Khalil is Yara's parent, and Layla Nasser
teaches Yara's Science class.

**Every** roster member can log in, not only the eight above. Each school also has two more
teachers (`hassan.ibrahim@`, `mona.farouk@`), eight more students and five more parents; the full
list is the demo roster in [`mock-credentials.ts`](../../db/seeds/mock-credentials.ts) with the
school's domain. That gives intra-tenant tests ("teacher A cannot see teacher B's class") a second
account with a session.

**Why the channel column matters.** Students, parents, teachers and attendance officers get no web
session (`403 WEB_ACCESS_MOBILE_ONLY`). Admin, platform, records and custom-list writes refuse
anything but a web session (`403 CHANNEL_NOT_AUTHORIZED`). Log in on the channel shown. A web login
still returns `access_token` in the body; only the refresh token goes to a cookie.

## Getting tokens (testers)

```bash
QA_LOGIN_PASSWORD='<password>' qa/get-tokens.sh   # ~30 s for all 15 accounts on staging limits
source qa/.tokens.env
curl -H "authorization: Bearer $QA_TOKEN_A_ORG_ADMIN" https://staging-api.studafy.com/api/auth/sessions
```

Or open `qa/bruno` in [Bruno](https://www.usebruno.com/), choose the `staging` environment, set the
`qaPassword` secret, and run the `Login` folder. See [`qa/README.md`](../../qa/README.md).

Access tokens live 15 minutes. Rerun the script to refresh them.

## Provisioning (staging, once)

1. **Apply migrations.** `000183_add_qa_tenant.sql` must be applied (`bun run db:migrate`).
2. **Set the password.** Generate at least 24 characters (the API refuses to boot with fewer) and
   add it to the staging API's app secrets as `QA_LOGIN_PASSWORD`, the same way as
   `REVIEW_LOGIN_PASSWORD` in [`app-review-access.md`](./app-review-access.md#provisioning-once-per-environment)
   (container `<name_prefix>/api/app-secrets`, see [`secrets-conventions.md`](./secrets-conventions.md)).
   **Never set it in production**: the API refuses to boot with `QA_LOGIN_PASSWORD` set when
   `APP_ENV=production`. While it is unset, `POST /api/auth/login/qa` answers 404.
3. **Seed the tenants**, with the migration/admin database credentials, against the staging database
   (directly, or through a tunnel on localhost):

   ```bash
   APP_ENV=staging QA_TENANT_SEED_CONFIRM=studafy-qa bun run db:seed:qa
   ```

   The seed refuses without the confirmation, with `APP_ENV=production`, against a
   production-shaped host (`prod`/`production` in the name), and against any host that is neither
   local nor staging-shaped. Schools that already exist are skipped, so it is safe to rerun.

4. **Verify**: `qa/get-tokens.sh` prints `ok` for all 15 accounts.

## Isolation and safety guarantees

| Guarantee                                               | Enforced by                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| The login cannot exist in production                    | `env.ts` refuses `QA_LOGIN_PASSWORD` when `APP_ENV=production`; unset, the route is 404.                                  |
| The QA accounts are not created in production           | `assertQaSeedAllowed` (confirmation, `APP_ENV`, host allowlist).                                                          |
| The password works only for QA tenants                  | Login resolves `(qa, email)` and refuses unless that school has `is_qa_tenant`. No real user has a `qa` identity.         |
| Review and QA logins cannot cross                       | Different provider, different secret, and `ck_schools_qa_tenant_not_review_tenant` forbids a school being both.           |
| Wrong password, unknown email, other school: same reply | One `401 AUTH_INVALID_CREDENTIALS`; password check and identity lookup always both run.                                   |
| Brute force is rate-limited                             | `/api/auth/login/qa` is `auth` (10 burst, about 10/min per IP). Not `auth-strict`, so one tester fits 15 logins in ~30 s. |
| SUPER_ADMIN is in neither school under test             | It lives alone in `studafy-qa-platform`.                                                                                  |
| No outbound email                                       | Every QA address is suppressed (`reason = 'qa_tenant'`).                                                                  |
| Post-login behaviour                                    | Same path as OAuth login: suspension policy, `last_login_at`, audit row (`provider: qa`), session tokens.                 |

QA tenants are billable, unlike the reviewer tenant, so checkout can be tested against the
staging payment providers' test keys.

## Known limitations

- **Testers can change data.** An ORG_ADMIN can deactivate other QA accounts. There is no reset:
  the seed only creates missing schools. To reset, delete the school and rerun the seed.
- **Dates are fixed** to the demo dataset's July 2026 window, as for the reviewer tenant.
- **Material files are not uploaded.** Lists, search and AI citations work, but downloads fail.
- **One shared password reaches SUPER_ADMIN on staging.** That was a deliberate QA-02 trade-off.
  Rotate it whenever a tester leaves: change the secret and redeploy the API.
