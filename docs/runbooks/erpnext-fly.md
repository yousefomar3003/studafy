# Runbook: ERPNext on fly (`studafy-core-erpnext`)

School finance runs on one private fly machine: MariaDB, Redis, Frappe's web and worker processes,
the scheduler and the site agent, under `supervisord`. The agent creates every approved school's
site by itself. Design and costs: [docs/plans/erpnext-fly.md](../plans/erpnext-fly.md).

| What        | Value                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| fly app     | `studafy-core-erpnext`, region `fra`, `shared-cpu-2x`, 2 GB, `infra/fly/erpnext.toml` |
| Volume      | `erpnext_data` (10 GB) at `/data`: MariaDB in `/data/mysql`, sites in `/data/sites`   |
| Address     | Flycast only, `http://studafy-core-erpnext.flycast:8000`. No public IP                |
| Sites       | `<slug>.erpnext.studafy.com`, picked by the `Host` header. No DNS records             |
| Backups     | nightly, 02:00 Asia/Amman, R2 bucket `studafy-prod-erpnext-backups`, 14 days          |
| Logs        | Axiom, dataset `studafy-logs`, `['fly.app.name'] == 'studafy-core-erpnext'`           |
| Deploy gate | repository variable `ERPNEXT_ENABLED`; ERPNext is skipped unless it is `true`         |

Every `fly` command runs from the repository root. Commands marked **(machine)** run inside
`fly ssh console -a studafy-core-erpnext`. Run `bench` as `frappe`, not root:

```sh
fly ssh console -a studafy-core-erpnext
su frappe
cd /home/frappe/frappe-bench
```

`supervisorctl` runs as root. Its programs are `mariadb`, `redis`, `web`, `worker`, `schedule` and
`agent`.

## 1. One-time setup

Do all of this before setting `ERPNEXT_ENABLED`. Until then the deploy workflow does nothing with
ERPNext.

1. **App and volume.** Use the same fly organisation as the other `studafy-core-*` apps (add
   `--org <slug>` if it is not your default).

   ```sh
   fly apps create studafy-core-erpnext
   fly volumes create erpnext_data --size 10 --region fra --app studafy-core-erpnext --yes
   ```

2. **A private address, and nothing public.** Allocate it **before** the first deploy: `fly deploy`
   gives an app with no address public ones.

   ```sh
   fly ips allocate-v6 --private --app studafy-core-erpnext
   fly ips list --app studafy-core-erpnext
   ```

   The list must show one `private_v6` address and nothing else: no `v4`, `v6` or shared IPv4. Remove
   anything else with `fly ips release <address> --app studafy-core-erpnext`. The workflow checks the
   same thing before and after every ERPNext deploy (`release.sh private-only`) and stops if it fails.

3. **Deploy token.** `FLY_API_TOKEN` in the `prod` environment holds one deploy token per app, joined
   with commas after a single `FlyV1 ` prefix ([infra/fly/README.md](../../infra/fly/README.md)).
   GitHub cannot show the current value, so build a new one that includes the ERPNext app:

   ```sh
   tokens=()
   for app in api realtime workers scanner web migrate erpnext; do
     tokens+=("$(fly tokens create deploy --app "studafy-core-$app" --name github-prod-deploy | sed 's/^FlyV1 //')")
   done
   (IFS=,; printf 'FlyV1 %s\n' "${tokens[*]}") | gh secret set FLY_API_TOKEN --env prod
   ```

4. **R2 backup bucket.** Create it in the **same account and jurisdiction as `studafy-prod-files`**:
   the workflow passes the files bucket's `S3_ENDPOINT` to the machine as `BACKUP_S3_ENDPOINT`. Add
   `--jurisdiction eu` to both commands if `studafy-prod-files` is an EU bucket.

   ```sh
   npx wrangler r2 bucket create studafy-prod-erpnext-backups
   npx wrangler r2 bucket lifecycle add studafy-prod-erpnext-backups expire-15d --expire-days 15
   npx wrangler r2 bucket lifecycle list studafy-prod-erpnext-backups
   ```

   The agent deletes backups after 14 days itself; the 15-day rule is the backstop. In the dashboard
   the same rule is R2 → bucket → Settings → Object lifecycle rules → "Delete objects after 15 days".

   Then the token: R2 → Manage R2 API tokens → Create API token → **Object Read & Write**, "Apply to
   specific buckets only" → `studafy-prod-erpnext-backups`. Keep the Access Key ID and Secret Access
   Key.

5. **Generate the secrets.** Hex only, so nothing needs quoting in a shell or on `bench`'s command
   line. Keep each one in the password manager.

   ```sh
   openssl rand -hex 24   # MARIADB_ROOT_PASSWORD
   openssl rand -hex 24   # ERPNEXT_ADMIN_PASSWORD (each new site's Administrator)
   openssl rand -hex 32   # ERPNEXT_AGENT_TOKEN
   openssl rand -hex 32   # ERPNEXT_WEBHOOK_SECRET (the webhook master secret)
   printf '%s:%s\n' "$(openssl rand -hex 8)" "$(openssl rand -hex 16)"   # ERPNEXT_API_KEY
   ```

   `ERPNEXT_API_KEY` is `<api_key>:<api_secret>`, one colon. The API sends it to every site, and the
   machine gets the same value as `STUDAFY_ERPNEXT_API_KEY`, which `provision.py setup` sets on each
   site's integration user. `ERPNEXT_WEBHOOK_SECRET` likewise reaches the machine as
   `STUDAFY_ERPNEXT_WEBHOOK_SECRET`; each site stores only its own derived secret
   ([erpnext-webhooks.md](erpnext-webhooks.md)). The workflow does both renames: store each value
   once.

6. **Put them in the `prod` environment.** Each command prompts for the value.

   ```sh
   for name in MARIADB_ROOT_PASSWORD ERPNEXT_ADMIN_PASSWORD ERPNEXT_AGENT_TOKEN ERPNEXT_WEBHOOK_SECRET \
     ERPNEXT_API_KEY BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY; do
     gh secret set "$name" --env prod
   done
   ```

   The rest is fixed in the workflow, not stored: `ERPNEXT_API_URL`
   (`http://studafy-core-erpnext.flycast:8000`), `ERPNEXT_SITE_DOMAIN` (`erpnext.studafy.com`),
   `STUDAFY_API_URL` (`https://api.studafy.com`), `BACKUP_S3_BUCKET` and `BACKUP_S3_ENDPOINT`.

7. **Turn it on**, only once the ERPNext code is on `main` and the owner has said go:

   ```sh
   gh variable set ERPNEXT_ENABLED --body true
   ```

   It is a **repository** variable, not a `prod` environment one: the job's timeout (60 minutes, 90
   with ERPNext) reads it at job level. From now on every production deploy includes ERPNext, so tell
   the coworkers who share the batch.

## 2. First deploy

1. **Run the batched deploy** from `main`:

   ```sh
   gh workflow run fly-production-deploy.yml --ref main
   gh run watch
   ```

   The steps named `ERPNext: …` now run. ERPNext deploys after the migrations and before the API,
   and its smoke check ends with `smoke ok: studafy-core-erpnext answers … with 404` (no site matches
   the probe's `Host`, so 404 means the web process is up). If any later step fails, ERPNext goes
   back to its previous image too. On this first release it has none and is left as it is.

2. **Check the machine.** The first boot prepares `/data` and can take a few minutes.

   ```sh
   fly status --app studafy-core-erpnext
   fly ips list --app studafy-core-erpnext   # still one private_v6, nothing else
   fly logs --app studafy-core-erpnext --no-tail
   ```

3. **Backfill** the schools approved before ERPNext existed (they have no `pending` row). The API
   image holds only the compiled server, so bundle the script from a checkout of the released commit
   (after `bun install`), copy it in, and run it with the API's own settings:

   ```sh
   bun build apps/api/scripts/backfill-erpnext-sites.ts --target bun --outfile /tmp/backfill-erpnext-sites.js
   echo "put /tmp/backfill-erpnext-sites.js /tmp/backfill-erpnext-sites.js" | fly ssh sftp shell -a studafy-core-api
   fly ssh console -a studafy-core-api
   ```

   Then, on the API machine:

   ```sh
   bun /tmp/backfill-erpnext-sites.js           # dry run: lists the schools it would register
   bun /tmp/backfill-erpnext-sites.js --apply   # writes the rows; safe to re-run
   rm /tmp/backfill-erpnext-sites.js
   ```

4. **Watch the sites being created.** The agent builds pending sites one at a time, oldest first.
   Time the first one and multiply to know when it will finish. In the Supabase SQL
   editor:

   ```sql
   SELECT status, count(*) AS rows, count(site_created_at) AS sites_created
   FROM app.erpnext_site_configs GROUP BY status;

   SELECT site_name, last_error, updated_at
   FROM app.erpnext_site_configs WHERE status = 'failed' ORDER BY updated_at;
   ```

   A created site goes back to `pending` with `site_created_at` set. It becomes `completed` on the
   school's first finance request. In Axiom (dataset `studafy-logs`):

   ```text
   ['studafy-logs']
   | where ['fly.app.name'] == 'studafy-core-erpnext'
   | sort by _time desc
   ```

   On the machine, `ls /data/sites` lists the sites on disk.

## 3. Production check (one test school)

Before telling schools that finance is available, on a test school whose site is created:

1. As the school's admin, create a fee structure and issue an invoice to a test student.
2. Record a cash payment against it, then refund it.
3. Open the finance reports and check the invoice, payment and refund appear with the right amounts.
4. Check the site woke up: within two minutes of the first request, its row has
   `scheduler_enabled = true` and `status = 'completed'`.
5. The morning after, check the night's backup is in R2 **(machine)**:

   ```sh
   export RCLONE_S3_PROVIDER=Cloudflare RCLONE_S3_ENDPOINT="$BACKUP_S3_ENDPOINT" \
     RCLONE_S3_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" RCLONE_S3_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
   rclone lsf -R ":s3:$BACKUP_S3_BUCKET" | sort | tail -n 20
   ```

## 4. Restore

### One site, from an R2 backup

Use this when one school's data is wrong or lost. Finance data entered after the backup's time is
gone from that site afterwards; check with the school.

**(machine)**, as `frappe` in `/home/frappe/frappe-bench`, with the `RCLONE_S3_*` exports from
section 3. Backup file names use the site name with dots as underscores.

```sh
site=<slug>.erpnext.studafy.com
rclone lsf -R ":s3:$BACKUP_S3_BUCKET" | grep "${site//./_}" | sort | tail -n 5
mkdir -p /data/restore
rclone copy ":s3:$BACKUP_S3_BUCKET/<path from the list>" /data/restore/
bench --site "$site" set-maintenance-mode on
bench --site "$site" restore /data/restore/<file>-database.sql.gz --db-root-password "$MARIADB_ROOT_PASSWORD" \
  --with-public-files /data/restore/<file>-files.tar --with-private-files /data/restore/<file>-private-files.tar
bench --site "$site" migrate     # only if the backup was taken on an older ERPNext image
bench --site "$site" set-maintenance-mode off
rm -rf /data/restore
```

If the site's folder is gone too, create it first as the agent does
(`bench new-site … --install-app erpnext --install-app education`, see the plan's "Site creation"),
copy `encryption_key` from the backup's `*-site_config_backup.json` with
`bench --site "$site" set-config encryption_key <value>`, then restore. Without that key the site
cannot decrypt the integration user's secret; re-running `provision.py setup` (as in
[erpnext-webhooks.md](erpnext-webhooks.md), step 2) also fixes it.

### The whole volume, from a fly snapshot

Use this only when the volume itself is lost or broken: it puts **every** school back to the
snapshot's time. Fly keeps a daily snapshot for 5 days.

```sh
fly volumes list --app studafy-core-erpnext                    # the current volume, vol_...
fly volumes snapshots list <vol-id>                             # pick a snapshot
fly volumes create erpnext_data --snapshot-id <snapshot-id> --size 10 --region fra --app studafy-core-erpnext --yes
fly machine list --app studafy-core-erpnext                     # the machine id
fly machine stop <machine-id> --app studafy-core-erpnext
fly machine clone <machine-id> --attach-volume <new-vol-id>:/data --region fra --app studafy-core-erpnext
fly machine destroy <machine-id> --force --app studafy-core-erpnext
```

Use the current size if the volume was extended. Check the sites answer (section 2, step 2), then
destroy the old volume after a few days: `fly volumes destroy <old-vol-id>`.

## 5. Upgrading ERPNext

1. **Bump the pin** in a PR: the `frappe/erpnext:version-15@sha256:…` digest in
   `infra/docker/erpnext-fly.Dockerfile`, and the same digest in `infra/docker/erpnext.Dockerfile` so
   local matches. The current digest of the tag:

   ```sh
   docker buildx imagetools inspect frappe/erpnext:version-15 --format '{{json .Manifest}}' | jq -r .digest
   ```

   Run the plan's local end-to-end test on the new image before merging.

2. **Release at night** (after 22:00 Asia/Amman), and run the migration straight after. The new image
   against unmigrated sites is not a state to leave running. Before the release, take a snapshot and
   a fresh backup:

   ```sh
   fly volumes snapshots create <vol-id>
   ```

   **(machine)**, as `frappe`: `bench --site all backup --with-files --compress`.

3. **Migrate** **(machine)**, as root. Stop the agent, worker and scheduler so the migration has the
   memory, and run it under `nohup` so a dropped SSH session does not stop it:

   ```sh
   supervisorctl stop agent worker schedule
   nohup su frappe -c 'cd /home/frappe/frappe-bench && time bench --site all migrate' > /data/migrate.log 2>&1 &
   tail -f /data/migrate.log
   supervisorctl start agent worker schedule   # when the log shows it finished
   ```

   Sites migrate one after another, each in maintenance mode while it runs, so each school's finance
   is unavailable for its own few minutes. Expect roughly 1–3 minutes a site for a patch release on
   this machine, more for a minor release; time one site first
   (`bench --site <site> migrate`) and multiply by the number of sites. If a site fails, fix it and
   re-run `--site all`: sites already migrated finish quickly.

Do not roll back the image after a migration: the schema has moved forward. Restore from the
snapshot taken in step 2 instead.

**MariaDB major version.** The image uses Debian's MariaDB (10.11 today). If a new base image moves
it to a new major version, run `mariadb-upgrade` **(machine)**, as root, once after the deploy and
before `bench migrate`. Nothing runs it automatically.

## 6. Resizing

**Memory to 4 GB** (about $22 a month):

```sh
fly scale memory 4096 --app studafy-core-erpnext
```

Then, in a PR, set the same memory in `infra/fly/erpnext.toml`, or the next deploy puts it back to
2 GB. Raise MariaDB's `innodb_buffer_pool_size` (384M today, in `infra/erpnext/fly/`) to about 1G in
the same PR.

**Extend the volume** (sizes only grow):

```sh
fly volumes list --app studafy-core-erpnext
fly volumes extend <vol-id> --size 20 --app studafy-core-erpnext
fly ssh console -a studafy-core-erpnext -C "df -h /data"
```

If `fly volumes extend` says the machine must restart, run
`fly machine restart <machine-id> --app studafy-core-erpnext` at night.

## 7. What to watch

| Signal              | Where                                                                                                       | Act when                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Memory              | fly dashboard → `studafy-core-erpnext` → Metrics; or `fly ssh console -a studafy-core-erpnext -C "free -m"` | above 80% for days, or 30–50 schools use finance actively → 4 GB (section 6)   |
| Disk                | `fly ssh console -a studafy-core-erpnext -C "df -h /data"`                                                  | above 70% → extend the volume (about $0.15 per GB a month)                     |
| Site creation       | `failed` rows with `last_error` (section 2, step 4); agent lines in Axiom                                   | any `failed` row still failing after a retry                                   |
| Nightly backups     | `rclone lsf` (section 3, step 5)                                                                            | a night with no new files                                                      |
| Out-of-memory kills | `fly logs --app studafy-core-erpnext --no-tail \| grep -i "out of memory"`                                  | any; more than one a week → 4 GB                                               |
| Restarts            | `fly status --app studafy-core-erpnext`, the machine's events                                               | each restart is 1–2 minutes of no finance; repeated restarts → troubleshooting |

## 8. Troubleshooting

**A site stuck in `failed`.** Read `last_error` (section 2, step 4) and the agent's lines for that
site in Axiom. The agent retries a failed row by itself 10 minutes after its last update. If
`bench new-site` stopped half-way, a retry can fail because the site or its database already exists;
drop it **(machine)**, as `frappe`, and the next retry builds it again:

```sh
bench drop-site <site> --db-root-password "$MARIADB_ROOT_PASSWORD" --no-backup --force
```

To retry at once rather than wait, in the SQL editor:
`UPDATE app.erpnext_site_configs SET updated_at = now() - interval '11 minutes' WHERE id = '<id>';`

**The agent gets 401.** Its `ERPNEXT_AGENT_TOKEN` differs from the API's. Both come from the same
`prod` secret on every deploy, so one app has not taken the latest value, or someone ran
`fly secrets set` by hand. Compare the digests:

```sh
fly secrets list --app studafy-core-api | grep ERPNEXT_AGENT_TOKEN
fly secrets list --app studafy-core-erpnext | grep ERPNEXT_AGENT_TOKEN
```

Rerun the deploy workflow to put both on the GitHub value. A **404** instead means the API has no
token at all, so its agent routes are not mounted: the API was not deployed with `ERPNEXT_ENABLED`
on.

**Out-of-memory kills.** `fly logs --app studafy-core-erpnext --no-tail | grep -i "out of memory"`
names the process. `supervisord` restarts it; if it was `mariadb`, every school's finance was down
until it came back. Usual causes: site creation running alongside heavy reports, or a migration with
the worker running. Once is noise. A pattern means resize (section 6).

**Disk full.** MariaDB stops accepting writes and finance fails for every school. **(machine)**:

```sh
df -h /data
du -sh /data/mysql /data/sites/*/private/backups 2>/dev/null | sort -h | tail
find /data/sites/*/private/backups -type f -mtime +1 -delete   # local copies; R2 has them
```

Then extend the volume (section 6) so it does not come back.

## 9. Rotating secrets

Change the value in the `prod` environment and rerun the deploy workflow. Every ERPNext secret is
staged on every app that uses it. Some need more:

- **`ERPNEXT_WEBHOOK_SECRET`** (webhook master secret): every site stores a secret derived from it,
  so after the deploy re-run `provision.py setup` on every site. Follow
  [erpnext-webhooks.md](erpnext-webhooks.md), step 5.
- **`ERPNEXT_API_KEY`**: each site's integration user still has the old key, so finance fails until
  `provision.py setup` has run again on every site (same command as the webhook secret). Rotate it
  together with the webhook secret.
- **`ERPNEXT_AGENT_TOKEN`**: nothing more. The deploy updates the API and the machine.
- **`MARIADB_ROOT_PASSWORD`**: MariaDB keeps the root password set when `/data/mysql` was first
  created, so changing the secret alone breaks site creation and restores. First change it in
  MariaDB **(machine)**:
  `mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -e "ALTER USER 'root'@'localhost' IDENTIFIED BY '<new>'"`,
  then update GitHub and deploy.
- **`ERPNEXT_ADMIN_PASSWORD`**: used only for new sites. For an existing site:
  `bench --site <site> set-admin-password <new>`.
- **`BACKUP_S3_*`**: create a new R2 token for the bucket, update both secrets, deploy, then delete
  the old token.

## Turning it off

`gh variable set ERPNEXT_ENABLED --body false` stops the workflow touching ERPNext, but the API and
workers keep the `ERPNEXT_*` secrets they already have. To switch finance off as well, unset them
and deploy:

```sh
fly secrets unset --stage --app studafy-core-api ERPNEXT_API_URL ERPNEXT_API_KEY ERPNEXT_WEBHOOK_SECRET ERPNEXT_SITE_DOMAIN ERPNEXT_AGENT_TOKEN
fly secrets unset --stage --app studafy-core-workers ERPNEXT_API_URL ERPNEXT_API_KEY
```
