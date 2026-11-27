# Plan: host ERPNext finance on Fly for $12–15 a month

Status: approved 2026-11-27, in progress. Branch: `feat/erpnext-fly` (from `dev` at 400f3135).

## Goal

Turn on school finance in production. Studafy's finance features (invoices, payments, fee
structures, fee schedules, installments, refunds, expenses, receipts, reports) already call ERPNext,
one Frappe site per school, but production has no ERPNext: there is no ERPNext Fly app and the
API has no `ERPNEXT_*` settings ([environment-matrix.md](../runbooks/environment-matrix.md)).

Constraints from the product owner:

- **Cost:** about $12–15 a month to start. Studafy is free for schools, and a school must stay under
  about $25 a year in total.
- **Sites:** every school gets its site **automatically when it is approved**, with no manual step.
- **No change to the finance code.** It already routes each school to its site by the `Host` header
  ([credential-resolver.ts](../../apps/api/src/modules/finance/client/credential-resolver.ts)).
- **Not in scope:** online payments (Tap and Stripe) stay off until the payments plan. Schools record
  cash and bank payments by hand.

## What already exists

| Piece                                                                | Where                                                                                                                                                                       |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ERPNext v15 + Education image, pinned by digest                      | [infra/docker/erpnext.Dockerfile](../../infra/docker/erpnext.Dockerfile)                                                                                                    |
| Site setup: setup wizard, integration user, per-site webhook secret  | [infra/erpnext/seed/provision.py](../../infra/erpnext/seed/provision.py) (`setup` step)                                                                                     |
| Local multi-container ERPNext                                        | `db/compose.yml` (`bun run erpnext:up`, `bun run erpnext:site`)                                                                                                             |
| School approval writes a `pending` row in `app.erpnext_site_configs` | [provisioning/service.ts](../../apps/api/src/modules/tenancy/provisioning/service.ts) (`registerErpNextSite`), called from email verification and platform-console approval |
| First finance request marks a ready site `completed`                 | `EnvCredentialResolver` (probes the site's `Company`)                                                                                                                       |
| Per-site webhook signatures                                          | [erpnext-webhooks.md](../runbooks/erpnext-webhooks.md)                                                                                                                      |

**The gap:** `bench new-site` cannot run over ERPNext's REST API, so today an operator creates every
site by hand. That cannot scale to hundreds of schools. Also, every school approved so far was
provisioned while ERPNext was unconfigured, so `registerErpNextSite` was skipped and those schools
have **no** row.

## Design

### One machine, everything on it

A new private Fly app, `studafy-core-erpnext`, runs on **one** machine:

| Process               | Notes                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| MariaDB 10.6          | Tuned for 2 GB: `innodb_buffer_pool_size=384M`, `performance_schema=OFF`, `max_connections=40`                                                     |
| Redis (cache + queue) | One local `redis-server`, `maxmemory 96mb`, two logical DBs. Not Redis Cloud: ERPNext's cache wants eviction and production Redis is `noeviction`. |
| Gunicorn (Frappe web) | 2 workers × 4 threads. Picks each school's site by the `Host` header.                                                                              |
| One RQ worker         | Listens on `short,default,long`                                                                                                                    |
| Scheduler             | `bench schedule`; per-site jobs only run for awake sites (see below)                                                                               |
| Site agent            | New, see below                                                                                                                                     |

All of these run under `supervisord` in one container. Fly process groups would put each process on
its own machine and multiply the cost.

**Not run:** the Frappe websocket server and nginx. Studafy uses ERPNext's REST API only, so it
needs no live desk UI or static assets. An operator who needs the ERPNext desk uses `fly proxy`.

**Machine:** `shared-cpu-2x`, 2 GB RAM, `swap_size_mb = 2048`, one 10 GB volume at `/data` (MariaDB
data directory and the bench `sites/` directory). No public IP: only a Flycast service on port 8000,
so only apps in the Studafy org network (the API and workers) can reach it.

**Cost:** about $11–12 for the machine plus $1.50 for the disk = **about $13 a month**.

### The site agent (automatic sites)

A small Python program (`infra/erpnext/agent/`) running on the ERPNext machine. It only makes
**outbound** calls to the Studafy API, authenticated with a new shared token
(`ERPNEXT_AGENT_TOKEN`):

1. **Every minute:** `GET /api/internal/erpnext/sites/pending`. For each site:
   `bench new-site <site> --install-app erpnext --install-app education` → `provision.py setup`
   (company, integration user, per-site webhooks pointing at `https://api.studafy.com`) →
   `bench --site <site> disable-scheduler` (new sites start **asleep**) →
   `POST /api/internal/erpnext/sites/{id}/created`. Runs one site at a time, so creation never takes
   more memory than the 2 GB machine has. On failure it reports `/failed` with the error, and
   retries with backoff.
2. **Every minute:** `GET /api/internal/erpnext/sites/wake`. For each site:
   `bench --site <site> enable-scheduler`, then report. A site is asked to wake when its school makes
   a finance request (see the API changes below). Finance REST calls work while a site is asleep;
   the scheduler only runs ERPNext's periodic jobs (overdue statuses and similar), so waking never
   blocks a request.
3. **Daily:** put to sleep any site with no finance activity for 30 days (the API returns the list).
4. **Nightly, 02:00 Asia/Amman:** `bench --site all backup --compress` → upload to R2 bucket
   `studafy-prod-erpnext-backups` with `rclone` → keep 14 days. The bucket is separate so a lifecycle
   rule can expire old backups, and backups never count against a school's storage meter.

### API changes (small)

- **Migration `000270`:** add to `app.erpnext_site_configs`:
  - `site_created_at timestamptz`
  - `scheduler_enabled boolean NOT NULL DEFAULT false`
  - `wake_requested_at timestamptz`
  - `last_finance_activity_at timestamptz`

  These are columns only. RLS is unchanged.

- **Internal agent routes** (`/api/internal/erpnext/...`):
  - `GET sites/pending`, `POST sites/{id}/created`, `POST sites/{id}/failed`
  - `GET sites/wake`, `POST sites/{id}/woken`
  - `GET sites/idle`, `POST sites/{id}/slept`

  Rules:
  - Bearer `ERPNEXT_AGENT_TOKEN` with a constant-time comparison.
  - Rate limited.
  - Platform scope, not tenant scope.
  - Left out of the public OpenAPI document.

  The pending list returns only what bench needs: site name, company, abbreviation, school id. No
  personal data.

- **Finance activity marker:** when `TenantErpNextFactory` builds a client for a school, set
  `last_finance_activity_at` (throttled to once an hour through Redis). If the site is asleep, also
  set `wake_requested_at`.
- **Backfill command:** `bun apps/api/scripts/backfill-erpnext-sites.ts` writes the missing
  `pending` row for every approved school, using the same `registerErpNextSite`. It is idempotent
  (`ON CONFLICT DO NOTHING`). Run once after the first deploy.
- **Settings** (from the GitHub `prod` environment, staged by the deploy workflow):
  - API: `ERPNEXT_API_URL=http://studafy-core-erpnext.flycast:8000`, `ERPNEXT_API_KEY`,
    `ERPNEXT_WEBHOOK_SECRET`, `ERPNEXT_SITE_DOMAIN=erpnext.studafy.com`, `ERPNEXT_AGENT_TOKEN`
  - Workers: `ERPNEXT_API_URL`, `ERPNEXT_API_KEY`
  - ERPNext machine: MariaDB root password, ERPNext admin password, `STUDAFY_ERPNEXT_API_KEY`,
    `STUDAFY_ERPNEXT_WEBHOOK_SECRET`, `ERPNEXT_AGENT_TOKEN`, R2 backup credentials
- **Route lists** to update for the new routes: route-guard coverage, audit coverage,
  permission-guard, OpenAPI document test (as excluded), horizontal-authz.

The site name stays `<slug>.erpnext.studafy.com`. Fly routes by app, not by DNS, and Frappe only
reads the `Host` header, so no DNS records are needed.

## Contract between the pieces (fixed; every workstream builds to this)

### Agent API (workstream C serves it, B calls it)

Base: `${STUDAFY_API_URL}/api/internal/erpnext` (production `https://api.studafy.com`). Every call
sends `Authorization: Bearer ${ERPNEXT_AGENT_TOKEN}`. A wrong or missing token gets 401. If the
API has no `ERPNEXT_AGENT_TOKEN` set, the routes answer 404 (not mounted). JSON in and out. `{id}`
is `app.erpnext_site_configs.id`.

| Call                                                                | Returns or does                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /sites/pending`                                                | `{ "sites": [{ "id", "school_id", "site_name", "company_name", "company_abbr", "currency_code", "country_code" }] }`. Rows with `site_created_at IS NULL` and status `pending`, or status `failed` last updated more than 10 minutes ago. Oldest first, at most 5. `currency_code` is ISO 4217 (default `JOD`); `country_code` is ISO 3166-1 alpha-2 uppercase (default `JO`). |
| `POST /sites/{id}/created`                                          | Sets `site_created_at = now()`, `scheduler_enabled = false`, `last_error = NULL`, status back to `pending` (the resolver marks it `completed` on the first finance request). 204.                                                                                                                                                                                              |
| `POST /sites/{id}/failed` with `{ "error": string (1–2000 chars) }` | Sets status `failed` and `last_error`. 204.                                                                                                                                                                                                                                                                                                                                    |
| `GET /sites/wake`                                                   | `{ "sites": [{ "id", "site_name" }] }`. Rows with `site_created_at IS NOT NULL`, `scheduler_enabled = false` and `wake_requested_at IS NOT NULL`.                                                                                                                                                                                                                              |
| `POST /sites/{id}/woken`                                            | `scheduler_enabled = true`, `wake_requested_at = NULL`. 204.                                                                                                                                                                                                                                                                                                                   |
| `GET /sites/idle`                                                   | `{ "sites": [{ "id", "site_name" }] }`. Rows with `scheduler_enabled = true` and `COALESCE(last_finance_activity_at, site_created_at) < now() - interval '30 days'`.                                                                                                                                                                                                           |
| `POST /sites/{id}/slept`                                            | `scheduler_enabled = false`. 204.                                                                                                                                                                                                                                                                                                                                              |

An unknown `{id}` gets 404.

### ERPNext machine (workstream A builds it, B runs inside it)

- Image `infra/docker/erpnext-fly.Dockerfile`, `FROM` the existing pinned `frappe/erpnext:version-15`
  digest with the Education app layered as in `erpnext.Dockerfile`. Adds `mariadb-server`,
  `redis-server`, `supervisor` and `rclone`. Copies `infra/erpnext/seed/` to
  `/home/frappe/frappe-bench/erpnext_seed/` and `infra/erpnext/agent/` to
  `/home/frappe/frappe-bench/erpnext_agent/`. Both are on `PYTHONPATH`.
- Volume at `/data`: MariaDB data in `/data/mysql`, bench sites in `/data/sites`, symlinked to
  `/home/frappe/frappe-bench/sites`.
- Web: gunicorn on `0.0.0.0:8000` (`frappe.app:application`, gthread, 2 workers, 4 threads,
  `--timeout 120`), with no default site, so `Host` picks the site.
- Supervisord programs: `mariadb`, `redis`, `web`, `worker` (`bench worker --queue short,default,long`),
  `schedule` (`bench schedule`), and `agent`. `agent` runs
  `/home/frappe/frappe-bench/env/bin/python -m erpnext_agent` as user `frappe`, with the working
  directory `/home/frappe/frappe-bench/sites`.
- Environment (Fly secrets): `MARIADB_ROOT_PASSWORD`, `ERPNEXT_ADMIN_PASSWORD`,
  `STUDAFY_API_URL`, `ERPNEXT_AGENT_TOKEN`, `STUDAFY_ERPNEXT_API_KEY`,
  `STUDAFY_ERPNEXT_WEBHOOK_SECRET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY_ID`,
  `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_BUCKET`. Backups are skipped with a warning when
  `BACKUP_S3_BUCKET` is unset (local runs).
- Fly app `studafy-core-erpnext`, config `infra/fly/erpnext.toml`, region `fra`, `shared-cpu-2x`,
  2048 MB, `swap_size_mb = 2048`, a `[[services]]` block on internal port 8000 (`auto_stop_machines =
"off"`, `min_machines_running = 1`), and `[mounts] source = "erpnext_data", destination = "/data"`.
  It is reached only through a private Flycast IP (`fly ips allocate-v6 --private`), never a public
  one.

### Site creation (B runs; mirrors `apps/api/scripts/init-local-erpnext.ts`)

```text
bench new-site <site> --mariadb-user-host-login-scope=localhost --db-root-password $MARIADB_ROOT_PASSWORD \
  --admin-password $ERPNEXT_ADMIN_PASSWORD --install-app erpnext --install-app education
../env/bin/python -m erpnext_seed.provision <site> setup --company <company_name> --abbr <company_abbr> \
  --currency <currency_code> --country-code <country_code> --school-id <school_id> --api-url $STUDAFY_API_URL
bench --site <site> disable-scheduler
```

`--country-code` is new: `provision.py` resolves it to ERPNext's `Country` by its `code` field. B adds
it; `--country` keeps working.

## Workstreams

Built in parallel by agents on one branch, `feat/erpnext-fly` (from `dev`).

| #   | Workstream                                                                                                                                                           | Files                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | ERPNext all-in-one image and Fly config: `supervisord`, MariaDB and Redis config, entrypoint that prepares `/data` on first boot and creates the bench config        | `infra/docker/erpnext-fly.Dockerfile`, `infra/erpnext/fly/*`, `infra/fly/erpnext.toml`                                                        |
| B   | Site agent: pending, wake, sleep and backup loops, with unit tests for the loop logic                                                                                | `infra/erpnext/agent/*`                                                                                                                       |
| C   | API: migration 000270, internal agent routes, activity and wake marker, backfill script, env validation, tests and route lists                                       | `db/migrations/000270_*`, `apps/api/src/modules/finance/erpnext-agent/*`, `apps/api/src/env.ts`, `apps/api/scripts/backfill-erpnext-sites.ts` |
| D   | Deploy wiring: add `studafy-core-erpnext` to `fly-production-deploy.yml` (build, stage secrets, deploy), and add the new secrets to the `prod` environment checklist | `.github/workflows/fly-production-deploy.yml`, [production-secrets.md](../runbooks/production-secrets.md)                                     |
| E   | Runbook: first deploy, backfill, restore from backup, upgrade ERPNext, resize to 4 GB, what to watch                                                                 | `docs/runbooks/erpnext-fly.md`                                                                                                                |

A and B are independent of C. D and E come last.

## Testing (before anything is deployed)

1. **Unit and API tests** for the agent routes, the marker and the backfill. Full API suite and
   `ci:local` green.
2. **Local end to end** with the new all-in-one image running in Docker, set to the same 2 GB limit:
   approve a school → the agent creates its site (asleep) → create a fee structure and an invoice →
   record a payment → a refund → finance reports → the site wakes on first use → backup and restore
   one site.
3. **Memory check:** with 10 sites created locally, measure memory while idle and during site
   creation. Creation must succeed without being killed for lack of memory.

## Release (with the next batched deploy, only on the owner's go)

1. Create the app and volume: `fly apps create studafy-core-erpnext`,
   `fly volumes create erpnext_data --size 10 --region fra`. Create the R2 backup bucket.
2. Add the new secrets to the GitHub `prod` environment.
3. Merge into the normal dev → stage → main flow. Deploy through `fly-production-deploy.yml`, which
   now includes ERPNext.
4. Run the backfill once (`fly ssh console -a studafy-core-api` → backfill script). The agent then
   creates a site for every approved school, one at a time.
5. **Production check** on one test school: invoice → payment → refund → reports. Check the first
   nightly backup in R2.
6. Then tell schools that finance is available.

## Watching it and when to grow

- **Memory** stays above 80% for days, or about 30–50 schools use finance actively → move to 4 GB
  (`fly scale memory 4096 -a studafy-core-erpnext`, about $22 a month).
- **Disk** above 70% → `fly volumes extend` (about $0.15 per GB per month).
- **Site creation errors** show in Axiom (the log shipper already ships every app's logs), and as
  `failed` rows with `last_error`.

## Limits to accept at this price

- Finance pages are slower than the rest of Studafy (2 GB, shared CPU).
- **One machine:** if it restarts, finance is unavailable for 1–2 minutes. Everything else in
  Studafy keeps working.
- **ERPNext upgrades** run `bench --site all migrate` at night. Finance is unavailable for a few
  minutes per run, and the run takes longer as schools are added.
- **Backups are nightly,** so at worst a day of finance data could be lost if the disk failed.
  Fly also keeps daily volume snapshots for 5 days.

## Progress

- [x] Owner approves this plan
- [ ] A: image and Fly config
- [ ] B: site agent
- [ ] C: API changes
- [ ] D: deploy wiring
- [ ] E: runbook
- [ ] Local end-to-end and memory check
- [ ] Merged to dev → stage
- [ ] Released with the batch, backfill run, production check passed
