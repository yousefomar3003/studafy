# ERPNext site agent

A small Python program that runs on the ERPNext Fly machine (`studafy-core-erpnext`) and does the
bench work the Studafy API cannot do over ERPNext's REST API. It only makes outbound calls to the
API's internal routes (`${STUDAFY_API_URL}/api/internal/erpnext/...`, bearer
`ERPNEXT_AGENT_TOKEN`). See [the plan](../../../docs/plans/erpnext-fly.md) for the full contract.

The image copies this directory to `/home/frappe/frappe-bench/erpnext_agent/` (on `PYTHONPATH`), and
supervisord runs `/home/frappe/frappe-bench/env/bin/python -m erpnext_agent` as `frappe`. It uses
the Python standard library only.

## What it does

One loop, one job at a time, so a backup never runs while a site is being created (2 GB machine).

| Job     | When                 | Does                                                                                                                                                                                                   |
| ------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pending | every 60 s           | `GET /sites/pending`; per site: `bench new-site` → `erpnext_seed.provision <site> setup` → `bench --site <site> disable-scheduler` → `POST /sites/{id}/created`. On failure `POST /sites/{id}/failed`. |
| wake    | every 60 s           | `GET /sites/wake` → `bench --site <site> enable-scheduler` → `POST /sites/{id}/woken`                                                                                                                  |
| idle    | at start, then daily | `GET /sites/idle` → `bench --site <site> disable-scheduler` → `POST /sites/{id}/slept`                                                                                                                 |
| backup  | 02:00 Asia/Amman     | `bench --site all backup --with-files --compress` → `rclone copy` each site's `private/backups/` to `<bucket>/<YYYY-MM-DD>/<site>/` → delete the local files → purge date folders older than 14 days   |

Details worth knowing:

- **Re-runs are safe.** If a site's directory already exists (it was created, but the report was
  lost), `new-site` is skipped; provision and `disable-scheduler` are idempotent. Before `new-site`
  the agent writes `sites/.erpnext-agent-creating.<site>` and removes it when `new-site` succeeds.
  A site directory with that marker next to it is half made (failed, timed out, or the machine
  stopped), so the next attempt runs `bench drop-site <site> --no-backup --force` and creates it again.
- **Errors sent to `/failed`** are the step plus the tail of its stderr (or stdout), at most 2000
  characters, with every secret value scrubbed. Logs are scrubbed the same way. A secret shorter
  than 4 characters cannot be scrubbed without shredding every message, so the agent logs
  `secret_too_short` (naming the variable) at start instead.
- **API trouble:** network errors, 429 and 5xx back off per job (15 s, 30 s, … capped at 5 minutes);
  a 401 (wrong token) or 404 (routes not mounted, the API has no `ERPNEXT_AGENT_TOKEN`) is logged as
  an error and retried every 5 minutes. Reports retry a few times in place. The agent never exits
  because of the API.
- **Timeouts:** 30 s per HTTP call; 15 min for `new-site` and provision; 2 min for the scheduler
  commands; 1 hour for the backup and each upload.
- **Shutdown (SIGTERM):** short steps finish; `new-site`, provision, backup and uploads are stopped
  (SIGTERM to their process group, SIGKILL after 10 s) and left for the next start. Give the
  supervisord program `stopwaitsecs` of at least 30.
- **Paths are absolute.** `sites/` is a symlink to `/data/sites`, so `../env` from inside it would
  resolve to `/data/env`. Bench commands run from `/home/frappe/frappe-bench`, provision from
  `/home/frappe/frappe-bench/sites` with `/home/frappe/frappe-bench/env/bin/python`.
- **Logs** are JSON lines on stdout: `time`, `level`, `event`, and where relevant `site`, `step`,
  `duration_s`, `outcome`, `error`.

## Environment

| Variable                                                                       | Required    | Use                                                                                |
| ------------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------- |
| `STUDAFY_API_URL`                                                              | yes         | API base (`https://api.studafy.com`); also the webhook target for provision        |
| `ERPNEXT_AGENT_TOKEN`                                                          | yes         | Bearer token for the agent routes                                                  |
| `MARIADB_ROOT_PASSWORD`                                                        | yes         | `bench new-site` / `drop-site` `--db-root-password`                                |
| `ERPNEXT_ADMIN_PASSWORD`                                                       | yes         | `bench new-site --admin-password`                                                  |
| `STUDAFY_ERPNEXT_API_KEY`                                                      | yes         | `<api_key>:<api_secret>`, passed to provision in its environment                   |
| `STUDAFY_ERPNEXT_WEBHOOK_SECRET`                                               | yes         | Master webhook secret, passed to provision in its environment                      |
| `BACKUP_S3_BUCKET`                                                             | no          | R2 bucket. Unset: backups are skipped with a warning (local runs)                  |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | with bucket | R2 endpoint and keys, turned into `RCLONE_CONFIG_STUDAFYBACKUP_*` (no config file) |
| `ERPNEXT_AGENT_BENCH_DIR`                                                      | no          | Bench root, default `/home/frappe/frappe-bench`                                    |

A missing required variable stops the agent at start with a `config_invalid` log line naming it.
Child processes get the agent's environment without `ERPNEXT_AGENT_TOKEN`.

## Tests

From the repo root, no Frappe needed (Python 3.9 or newer):

```sh
python3 -m unittest discover -s infra/erpnext/agent/tests
```

They fake the agent API with a local `http.server` and the bench and rclone commands with a fake
runner.

## Running it by hand in the container

```sh
fly ssh console -a studafy-core-erpnext
su frappe -s /bin/bash          # keeps the environment, so the Fly secrets come along
cd /home/frappe/frappe-bench/sites

# One pending, wake and idle pass, then exit:
/home/frappe/frappe-bench/env/bin/python -m erpnext_agent once
# One backup now (needs BACKUP_S3_*):
/home/frappe/frappe-bench/env/bin/python -m erpnext_agent backup
```

Use the absolute python path (see "Paths are absolute" above). If a variable is missing the agent
says which one and exits. Stop the supervisord program first (`supervisorctl stop agent`, then
`start` it again afterwards) for `once` and `backup`, so two site creations or a creation and a
backup never run together on the 2 GB machine.
