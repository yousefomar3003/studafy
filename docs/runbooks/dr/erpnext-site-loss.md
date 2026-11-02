# Scenario 3: ERPNext site data loss (single school)

One school's ERPNext site (`sites/<hostname>` on the shared EFS filesystem every ERPNext ECS task
mounts) has bad or missing data — an admin's mistake, a bad import, a bug — while every other
school's site and the MariaDB instance itself are fine. Instance-wide loss is
[mariadb-instance-loss.md](mariadb-instance-loss.md) instead.

Mechanism source: [`infra/terraform/modules/backup/erpnext_backup.tf`](../../../infra/terraform/modules/backup/erpnext_backup.tf),
[`infra/deploy/erpnext/backup/erpnext-backup.sh`](../../../infra/deploy/erpnext/backup/erpnext-backup.sh),
[`infra/deploy/erpnext/backup/erpnext-restore-drill.sh`](../../../infra/deploy/erpnext/backup/erpnext-restore-drill.sh).
Comms templates: [README.md](README.md).

## RPO / RTO target

Per `docs/architecture/SAD_30_backup_policy.md`: **RPO up to 24 hours** — one `bench backup
--with-files` run per night, default 02:00 UTC (`erpnext_site_backup_schedule`). A mid-day incident
loses at most that day's changes for that one school. **RTO**: the monthly drill measures only the
restore-to-verified-healthy portion; this runbook's cutover step is new — see "What the drill
doesn't cover" below.

## Detection

No automated alarm. A school reporting wrong data, or `bench --site <hostname> doctor` failing
during unrelated operational work, are the realistic signals today.

## Owner

Data-plane operator; incident commander confirms which school/site before anything runs (see
decision point 1 — restoring the wrong site is a second incident, not a fix for the first).

## Decision points

1. **Confirm the exact site hostname.** `var.erpnext_site_hostnames` (space-separated,
   `erpnext_backup.tf`) is the list of real hostnames each has a nightly backup under
   `s3://<backups-archive>/erpnext/<hostname>/`. Get this right before step 2 — there is no
   confirmation prompt in the restore command.
2. **Is this the whole site, or one doctype/table?** `bench restore` replaces the _entire_ site
   database — there is no partial/table-level restore. If only one doctype's records are wrong,
   consider whether a targeted SQL fix (out of this runbook's scope, needs its own review) is safer
   than losing every change made to the whole site since last night's backup.
3. **Which backup?** Default is the latest (`s3://.../erpnext/<hostname>/<latest-run-id>/`,
   discoverable via `aws s3 ls`). If the bad data is already inside last night's backup (the mistake
   happened before 02:00 UTC), you need an older one — nightly-only backups mean the further back
   you go, the more otherwise-good same-day changes you also lose. Pick the most recent backup that
   predates the bad write.

## What the drill doesn't cover — and this runbook does

`erpnext-restore-drill.sh` restores into a **scratch site named `restore-drill.internal`**, runs
`bench doctor` plus a `tabUser` row-count check, then **drops it unconditionally in `cleanup()`**.
That's deliberate for a monthly drill (never touch the real site, prove the mechanism, clean up)
and is exactly why `docs/architecture/SAD_30_backup_policy.md`'s "Known gaps" says ERPNext's RTO
"stops at site restored and bench doctor passes" — re-pointing real traffic was, until this ticket,
undocumented.

It turns out to be simpler than Postgres/MariaDB's cutover: ERPNext's multi-tenancy routes by
**HTTP Host header** (`FRAPPE_SITE_NAME_HEADER = "$host"`, `modules/erpnext/main.tf`) against
whatever site directories exist under the shared `sites/` EFS mount. There is no DNS rename, no
instance swap — restoring directly into `sites/<the real hostname>` (instead of a scratch name) is
the entire cutover. The moment the site directory exists again with good data, the next request for
that hostname resolves to it.

## Procedure

**1. Find the right backup.**

```bash
BUCKET="$(terraform -chdir=infra/terraform output -raw storage_backups_archive_bucket_id)"
SITE="school-a.studafy.example"   # the real hostname from decision point 1

aws s3 ls "s3://${BUCKET}/erpnext/${SITE}/"
# pick the run-id prefix per decision point 3, not necessarily the latest
RUN_ID="20260907-020000"
aws s3 sync "s3://${BUCKET}/erpnext/${SITE}/${RUN_ID}/" ./restore-workdir/
```

**2. Get MariaDB root credentials** (same secret `erpnext-restore-drill.sh` reads):

```bash
SECRET_ARN="$(terraform -chdir=infra/terraform output -raw mariadb_connection_secret_arn)"
SECRET_JSON="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text)"
ROOT_USER="$(jq -r '.username' <<<"$SECRET_JSON")"
ROOT_PASSWORD="$(jq -r '.password' <<<"$SECRET_JSON")"
```

**3. Run this from a bench container that already mounts the real `sites/` EFS access point** — not
a laptop. The simplest way to get one: `aws ecs run-task` the existing
`erpnext_site_setup_task_definition_arn` (the same task definition
`infra/deploy/scripts/erpnext-new-site.sh` uses) with a shell override, or exec into a running
backend task (`aws ecs execute-command`) if enabled.

If the site is still present but corrupted, restore over it with `--force` (bench's documented flag
for overwriting an existing site's database — not independently re-verified against this repo's
pinned bench version, same caveat `modules/backup/README.md`'s Known gaps already carries for every
other `bench` flag this repo relies on):

```bash
DB_DUMP="$(find ./restore-workdir -name '*-database.sql.gz')"
PUBLIC_FILES="$(find ./restore-workdir -name '*-files.tar' ! -name '*-private-files.tar')"
PRIVATE_FILES="$(find ./restore-workdir -name '*-private-files.tar')"

bench --site "$SITE" restore "$DB_DUMP" \
  --mariadb-root-username "$ROOT_USER" --mariadb-root-password "$ROOT_PASSWORD" \
  --with-public-files "$PUBLIC_FILES" --with-private-files "$PRIVATE_FILES" \
  --force
```

If the site directory is gone entirely (not just corrupted), `bench new-site "$SITE" ...` first,
exactly as `erpnext-restore-drill.sh` does for its scratch site, using the real hostname instead of
`restore-drill.internal`.

**4. Verify — same checks the drill already runs, against the real site:**

```bash
bench --site "$SITE" doctor
bench --site "$SITE" mariadb --execute "SELECT COUNT(*) FROM tabUser;" --silent --skip-column-names
```

**5. No further cutover step.** Traffic for `$SITE`'s hostname is already routed here by the
Host-header mechanism — confirm by hitting the real URL, not by touching DNS/ALB/Terraform.

## Rollback / abort criteria

If `bench doctor` fails after restore, do not tell the school it's fixed — try an older backup
(decision point 3) or escalate. A site restore is not reversible without another restore, so verify
before declaring resolved.

## Known gaps

- **RTO for real cutover is now documented (this runbook) but never timed against real infra** —
  the monthly drill only ever timed the scratch-site path.
- No script does steps 1-4 against a real hostname; `erpnext-restore-drill.sh` is drill-only by
  design (see its own header comment) and shouldn't be repurposed by passing a real hostname as an
  env var — it still drops whatever site it touches in `cleanup()`.
- `--force`'s exact restore-over-existing-site behavior is asserted from bench's documented flags,
  not from having run it in this repo.
- 24-hour RPO ceiling is inherent to nightly-only backups — a school incident on the wrong side of
  02:00 UTC loses up to a full day. Raising backup frequency for schools where that's unacceptable
  is a policy decision, not something this runbook changes unilaterally.
