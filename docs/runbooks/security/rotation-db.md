# Secret rotation: database credentials

The password of the Supabase project's `postgres` user — the login api, workers and migrations all
use (`infra/fly/README.md#database-connections`). The services hold it as the `DATABASE_PASSWORD`
secret in the `prod` GitHub Environment. This is one of the four secret classes in the quarterly
rotation schedule ([`rotation-schedule.md`](rotation-schedule.md)); the inventory lives in
[`secrets-conventions.md`](../secrets-conventions.md).

Per-service application secrets (provider keys, webhook secrets, `WS_JWT_SECRET`) are a different
class — [`rotation-provider-api-keys.md`](rotation-provider-api-keys.md).

## Nothing rotates it automatically

The AWS stack rotated the RDS master credential with a Secrets Manager Lambda; that is gone with
AWS. On Supabase nothing in this repo rotates the password: a rotation is a manual change at
Supabase followed by a deploy.

## Procedure

1. Set a new password for the database in the Supabase dashboard (project `studafy-prod`, Project
   Settings → Database).
2. Put the same value in the `prod` GitHub Environment's `DATABASE_PASSWORD` secret.
3. Run **Production deploy (fly.io)**. It stages the new secret onto `studafy-core-migrate`,
   `studafy-core-api` and `studafy-core-workers`, runs migrations with it (a wrong password fails
   that step and releases nothing), then redeploys the apps.
4. Verify: the migration step logged "database is up to date", `curl -sf
https://api.studafy.com/readyz` answers 200, and `fly logs --app studafy-core-workers` shows no
   authentication errors.

## Honest zero-downtime assessment

- **This rotation is not zero-downtime.** Between step 1 and the end of step 3, any new database
  connection the running machines open with the old password is refused. How long that is depends
  on how long the deploy takes; it has not been measured on fly.
- **Established connections** are not dropped by a password change, so pooled server sessions keep
  working until they are recycled.
- A zero-window rotation needs two interchangeable credentials (e.g. per-service login roles in
  role `studafy_app`), swapped one at a time. None exist yet: moving the services off `postgres` is
  the open follow-up in `docs/security/S-01-database-role-verification.md`.

## Failure triage

- **The migration step fails on authentication**: the GitHub secret does not match what Supabase
  now has. Fix the secret and rerun the workflow; nothing was released.
- **api or workers fail to connect after the deploy** while migrations succeeded: migrations
  connect directly as `postgres`, the services through the transaction pooler as
  `postgres.<project ref>` (`DATABASE_USER`). Check the pooler login in the Supabase dashboard and
  `fly logs` for the failing app.

## Known gaps

- No automatic rotation, and the window described above is unmeasured.
- The Redis Cloud credential (`REDIS_URL`) is a separate secret class with no rotation procedure
  yet (see the schedule's status table and [`secrets-conventions.md`](../secrets-conventions.md)).
