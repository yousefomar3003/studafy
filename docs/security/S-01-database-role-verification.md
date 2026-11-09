# S-01: can the runtime database login bypass Row-Level Security?

QA-16 ([QA plan](../testing/qa-plan.md), [findings register](findings-register.md) S-01).

## Why it matters

The API and workers reach Postgres through PgBouncer, and every PgBouncer pool logs in as the **RDS
master user**: it is the only credential that exists
([`modules/pgbouncer/README.md`](../../infra/terraform/modules/pgbouncer/README.md) "It does not
create a per-service Postgres role"; `user_data.sh.tftpl` writes `user=$PG_USER` from the master
secret into every pool). Application code is meant to run each transaction as `studafy_app` with
`app.school_id` set (`withTenantTx`), which Row-Level Security then scopes to one school.

Code that queries the pool directly skips both. What happens then depends on the login:

| The master login…   | A raw query on a tenant table…                                                 |
| ------------------- | ------------------------------------------------------------------------------ |
| bypasses RLS        | reads/writes **every school's rows**: a cross-tenant leak (F-17 becomes High). |
| does not bypass RLS | sees nothing: reads come back empty and updates change nothing, silently.      |

Neither is acceptable, but which one we have decides severity. Local and CI databases cannot answer
it: there the login (`studafy_test`) is a true superuser and always bypasses RLS.

Raw queries on tenant tables found by QA-16's lint rule (`studafy/no-raw-pool-query`, allowlisted
in the root `eslint.config.js`):

- `tenancy/provisioning/service.ts`: `app.subscriptions` read and updated, `app.erpnext_site_configs`
  read (already F-17).
- `tenancy/verification/service.ts:119,151`: the new school's admin read from `app.users` (new; added
  to F-17).

## How to run the check (staging, then prod)

The script is read-only: it opens a `READ ONLY` transaction, rolls it back, and reads only role
metadata and row **counts**, no personal data.

1. Connect to the environment's bastion (same access as
   [`migration-failure.md`](../runbooks/migration-failure.md) step 3b).
2. Get the runtime login's credentials from the Postgres connection secret
   (`module.postgres` `connection_secret_arn`, the same secret PgBouncer reads): `host`, `port`,
   `dbname`, `username`, `password`.
3. Copy [`s01-db-role-audit.sql`](s01-db-role-audit.sql) to the bastion.
4. Run it **as that login**, against the primary:

   ```sh
   psql "host=<host> port=<port> dbname=<dbname> user=<username> sslmode=require" \
     -f s01-db-role-audit.sql > s01-<environment>.txt
   ```

5. Paste the output into "Results" below (staging and prod separately), then fill in the verdict.
6. If the environment is not deployed yet, write "not deployed" with the date, and run it when it is.

## Reading the output

Section 6 is the deciding one: it counts rows in `app.users` and `app.subscriptions` as the bare
login, with no role and no school set.

| Section 6 shows                                                  | Verdict                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| counts above 0 (and `schools_seen_in_users` above 1)             | **Bypasses RLS.** S-01 confirmed. Do "If the login bypasses RLS". |
| `0` and `0`                                                      | RLS applies to the login. S-01 closed; F-17 stays Medium.         |
| an error: `unrecognized configuration parameter "app.school_id"` | RLS applies (the policy needed a school). Same as `0`.            |
| an error: `permission denied for table users`                    | The login cannot read the table at all. Same as `0`.              |

Sections 2 to 4 explain the why: `rolsuper` or `rolbypassrls` true on the login, or on any role it
holds (section 4), means it bypasses RLS. On RDS the master user is not a true superuser; its power
comes from `rds_superuser` membership, which is why section 4 lists inherited roles.

## Results

### Staging

- Date / run by:
- Output: (paste)
- Verdict:

### Prod

- Date / run by:
- Output: (paste)
- Verdict:

## If the login bypasses RLS

1. Raise F-17 to **High** in the [findings register](findings-register.md) and the QA plan.
2. Open this ticket:

   > **Least-privilege runtime database login (S-01)**
   >
   > The API and workers connect through PgBouncer as the RDS master user, which bypasses RLS, so any
   > query that skips `withTenantTx` reads across schools. Create a login role `studafy_runtime`
   > (`LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`, member of `studafy_app` only, plus
   > `studafy_admin` only if a runtime path genuinely needs it), point every PgBouncer pool at it, and
   > keep the master credential for migrations only. Acceptance: this script's section 6 shows `0`
   > for the runtime login on staging and prod; the API and workers pass their smoke tests; the
   > migration task still runs as the master user.

3. Until it ships, fix the tenant-table raw queries above first (F-17, QA-29).

## What prevents new raw queries

`studafy/no-raw-pool-query` ([`packages/config/rules/no-raw-pool-query.js`](../../packages/config/rules/no-raw-pool-query.js))
is a lint error in `apps/api/src/modules/**`. The files that still query the pool are listed in
`RAW_POOL_QUERY_ALLOWLIST_COUNTS` in the root `eslint.config.js`, each with a reason and an exact
count; [`raw-pool-query-lint.test.ts`](../../apps/api/tests/security/raw-pool-query-lint.test.ts)
fails CI if a count changes. The rule matches the pool's names, not its type, so an alias
(`features/catalog.ts`: `const sql = pool(database)`, global tables only) is not caught.
