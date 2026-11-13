# S-01: can the runtime database login bypass Row-Level Security?

QA-16 ([QA plan](../testing/qa-plan.md), [findings register](findings-register.md) S-01).

## Why it matters

The API and workers reach Postgres through Supabase's transaction pooler, and they log in as the
Supabase project's **`postgres` user** (`DATABASE_USER` = `postgres.<project ref>` in the `prod`
GitHub Environment; see [`infra/fly/README.md`](../../infra/fly/README.md) "Database connections").
It is the only runtime credential that exists, as the RDS master user was before AWS was retired.
Application code is meant to run each transaction as `studafy_app` with
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

## How to run the check (prod)

The script is read-only: it opens a `READ ONLY` transaction, rolls it back, and reads only role
metadata and row **counts**, no personal data.

1. Get the runtime login's connection settings: host and port from `infra/fly/api.toml`
   (`DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`), user and password from the `DATABASE_USER`
   and `DATABASE_PASSWORD` secrets of the `prod` GitHub Environment, and Supabase's root CA
   (`DATABASE_CA_CERT`).
2. Run [`s01-db-role-audit.sql`](s01-db-role-audit.sql) **as that login**:

   ```sh
   psql "host=<host> port=<port> dbname=<dbname> user=<username> sslmode=verify-full sslrootcert=<ca.pem>" \
     -f s01-db-role-audit.sql > s01-prod.txt
   ```

3. Paste the output into "Results" below, then fill in the verdict.

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
holds (section 4), means it bypasses RLS. Supabase's `postgres` is not a true superuser (as RDS's master user was
not); whatever power it has comes from the roles it holds, which is why section 4 lists inherited
roles.

## Results

There is no staging environment any more; prod is the only deployed database.

### Prod

- Date / run by:
- Output: (paste)
- Verdict:

## If the login bypasses RLS

1. Raise F-17 to **High** in the [findings register](findings-register.md) and the QA plan.
2. Open this ticket:

   > **Least-privilege runtime database login (S-01)**
   >
   > The API and workers connect through Supabase's pooler as `postgres`, which bypasses RLS, so any
   > query that skips `withTenantTx` reads across schools. Create a login role `studafy_runtime`
   > (`LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`, member of `studafy_app` only, plus
   > `studafy_admin` only if a runtime path genuinely needs it), point the API and workers at it, and
   > keep `postgres` for migrations only. Acceptance: this script's section 6 shows `0` for the
   > runtime login on prod; the API and workers pass their smoke tests; the migrate machine still
   > runs as `postgres`.

3. Until it ships, fix the tenant-table raw queries above first (F-17, QA-29).

## What prevents new raw queries

`studafy/no-raw-pool-query` ([`packages/config/rules/no-raw-pool-query.js`](../../packages/config/rules/no-raw-pool-query.js))
is a lint error in `apps/api/src/modules/**`. The files that still query the pool are listed in
`RAW_POOL_QUERY_ALLOWLIST_COUNTS` in the root `eslint.config.js`, each with a reason and an exact
count; [`raw-pool-query-lint.test.ts`](../../apps/api/tests/security/raw-pool-query-lint.test.ts)
fails CI if a count changes. The rule matches the pool's names, not its type, so an alias
(`features/catalog.ts`: `const sql = pool(database)`, global tables only) is not caught.
