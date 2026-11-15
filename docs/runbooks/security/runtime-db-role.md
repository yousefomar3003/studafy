# Runbook: move the services to a least-privilege database login (QA-014 / S-01)

**Status:** the code side is DONE (QA-014). This runbook is the remaining production step. A person with Supabase and Fly access has to carry it out; it is not automated.

## Why

`api`, `workers` and `realtime` currently log in as Supabase `postgres` (through the transaction pooler, user `postgres.<project ref>`). That login can bypass Row-Level Security, so tenant isolation of minors' data rests on application code alone. The S-01 finding (`docs/security/findings-register.md`) is still unverified.

Since QA-014, no query reads or writes a table outside the app's own role switches (`withTenantTx`, `withSystemTx`, `withAppTx`). The CI job `least-privilege-db` proves this on every PR. It runs the whole API suite logged in as `studafy_runtime`, which has NOSUPERUSER, NOBYPASSRLS and owns nothing, and any new dependency on bypass fails the job.

## Before you start

- [ ] The newest `qa/*` branch, or `dev` after the merge, is deployed. Older builds still need the bypass.
- [ ] The `least-privilege-db` CI job is green on the deployed commit.
- [ ] You can run SQL in the Supabase SQL editor for `studafy-prod`, and you can run `fly secrets` for `studafy-core-api`, `studafy-core-workers` and `studafy-core-realtime`.
- [ ] You have a rollback window: the old login keeps working until step 5, so rollback is just restoring the old secrets.

## Steps

1. **Create the login.** In the Supabase SQL editor, generate the password in your password manager. Never paste it into chat, tickets or logs.

   ```sql
   CREATE ROLE studafy_runtime LOGIN PASSWORD '<generated>'
     NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
   GRANT studafy_app   TO studafy_runtime WITH INHERIT FALSE, SET TRUE;
   GRANT studafy_admin TO studafy_runtime WITH INHERIT FALSE, SET TRUE;
   -- Migration 000002 revokes CONNECT from PUBLIC, and INHERIT FALSE passes nothing through:
   -- without this the login is refused ("User does not have CONNECT privilege"). Compare the
   -- 2026-11-11 pooler outage in infra/fly/README.md.
   GRANT CONNECT ON DATABASE postgres TO studafy_runtime;
   ```

   `WITH INHERIT FALSE, SET TRUE` needs Postgres 16+, which Supabase runs.

2. **Verify the role** before anything uses it:

   ```sql
   SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'studafy_runtime';
   -- expect: studafy_runtime | f | f
   SELECT r.rolname, m.inherit_option, m.set_option
   FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
   JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'studafy_runtime';
   -- expect: studafy_admin | f | t  and  studafy_app | f | t
   ```

3. **Pooler.** Supavisor authenticates custom roles as `<role>.<project ref>`. Confirm that a connection as `studafy_runtime.<project ref>` to `aws-1-eu-central-1.pooler.supabase.com:6543` succeeds (for example with `psql` from a trusted machine) and that `SELECT current_user` returns `studafy_runtime`.

4. **Switch one service first: workers.** It has the narrowest blast radius and fails loudly in logs.

   ```bash
   fly secrets set -a studafy-core-workers DATABASE_USER='studafy_runtime.<project ref>' DATABASE_PASSWORD='<generated>'
   ```

   Watch Axiom for `permission denied` and `CONNECT` errors for 15 minutes. Check that an outbox event is relayed and an email is dispatched.

5. **Switch the API and realtime** the same way. Then smoke test: sign-in, refresh, a student list, a registration, the email-bounce webhook (Resend test event) and an ERPNext webhook (sandbox).

6. **Leave migrations on `postgres`.** The migrate machine (`infra/fly/migrate.toml`) still logs in as the owner on :5432, because migrations need DDL.

7. **Record the result** in `docs/security/S-01-database-role-verification.md`, including the step 2 output, and mark S-01 verified in the findings register.

## Rollback

Restore the previous `DATABASE_USER` and `DATABASE_PASSWORD` secrets on the affected app with `fly secrets set`; the machines restart with the old login. Do **not** drop `studafy_runtime` during an incident; leave it for the retry.

## After

- Rotate the `postgres` password. It's no longer needed by the services and should leave their secret stores (`docs/runbooks/security/rotation-db.md`).
- QA-015 follows: move system transactions off the owner role `studafy_admin` onto a non-owner `studafy_system`.
