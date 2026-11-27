"""Nightly backups: `bench --site all backup --compress`, then each site's files to R2 with rclone.

Layout in the bucket: `<YYYY-MM-DD>/<site>/<bench's backup files>`, the date in Asia/Amman. Date
folders older than 14 days are purged. Local backup files are deleted once uploaded, so the 10 GB
volume never collects them; anything a failed upload left behind goes up with the next night's run.

rclone is configured only through RCLONE_CONFIG_* environment variables (no config file).
"""

from __future__ import annotations

import os
import re
import time
from datetime import date, datetime, time as dtime, timedelta, timezone

from .redact import error_message
from .runner import child_env

BACKUP_HOUR = 2  # 02:00 Asia/Amman
RETENTION_DAYS = 14
BACKUP_TIMEOUT = 60 * 60
UPLOAD_TIMEOUT = 60 * 60
LIST_TIMEOUT = 5 * 60
PURGE_TIMEOUT = 15 * 60
REMOTE = "studafybackup"  # the rclone remote name the RCLONE_CONFIG_STUDAFYBACKUP_* variables define
DATE_DIR_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})/?$")


def amman_tz():
    """Asia/Amman from the system tz database; Jordan has been fixed at UTC+3 since 2022, which is
    the fallback when the image has no tz data."""
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo("Asia/Amman")
    except Exception:  # ZoneInfoNotFoundError, or no tz data at all
        return timezone(timedelta(hours=3), "Asia/Amman")


AMMAN = amman_tz()


def next_backup_at(now: datetime, tz=AMMAN, hour: int = BACKUP_HOUR) -> datetime:
    """The first `hour`:00 local time strictly after `now` (an aware datetime), in UTC."""
    local = now.astimezone(tz)
    candidate = datetime.combine(local.date(), dtime(hour), tzinfo=tz)
    if candidate <= local:
        candidate = datetime.combine(local.date() + timedelta(days=1), dtime(hour), tzinfo=tz)
    return candidate.astimezone(timezone.utc)


def expired_date_dirs(names, today: date, keep_days: int = RETENTION_DAYS) -> list:
    """The `YYYY-MM-DD` folder names older than `keep_days` before `today`; anything else is kept."""
    cutoff = today - timedelta(days=keep_days)
    expired = []
    for name in names:
        match = DATE_DIR_RE.match(name.strip())
        if not match:
            continue
        try:
            folder = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            continue
        if folder < cutoff:
            expired.append(name.strip().rstrip("/"))
    return expired


class Backup:
    def __init__(self, config, runner, log, stop, clock=None, tz=AMMAN):
        self.config = config
        self.runner = runner
        self.log = log
        self.stop = stop
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.tz = tz

    def next_run(self, now_epoch: float) -> float:
        return next_backup_at(datetime.fromtimestamp(now_epoch, timezone.utc), self.tz).timestamp()

    def rclone_env(self) -> dict:
        cfg = self.config
        prefix = f"RCLONE_CONFIG_{REMOTE.upper()}_"
        env = child_env()
        env.update(
            {
                prefix + "TYPE": "s3",
                prefix + "PROVIDER": "Cloudflare",
                prefix + "ENDPOINT": cfg.backup_endpoint,
                prefix + "ACCESS_KEY_ID": cfg.backup_access_key_id,
                prefix + "SECRET_ACCESS_KEY": cfg.backup_secret_access_key,
                prefix + "REGION": "auto",
                prefix + "ACL": "private",
                # R2 tokens are usually scoped to one bucket's objects and may not create buckets.
                prefix + "NO_CHECK_BUCKET": "true",
            }
        )
        return env

    def run(self) -> None:
        cfg = self.config
        if not cfg.backups_enabled:
            self.log.warning("backup_skipped", outcome="skipped", detail="BACKUP_S3_BUCKET is not set")
            return
        start = time.monotonic()
        day = self.clock().astimezone(self.tz).date()
        self.log.info("backup_started", day=day.isoformat())

        result = self.runner.run([cfg.bench_bin, "--site", "all", "backup", "--compress"],
                                 cwd=cfg.bench_dir, timeout=BACKUP_TIMEOUT, interruptible=True,
                                 env=child_env())
        if result.interrupted:
            self.log.warning("backup_interrupted", outcome="interrupted", duration_s=result.duration)
            return
        failures = 0
        if not result.ok:
            # Some sites may still have backed up; upload whatever was written.
            failures += 1
            self.log.error("backup_bench_failed", outcome="failed", duration_s=result.duration,
                           error=error_message(self.log.redact, f"exit {result.returncode}", result.output))
        else:
            self.log.info("backup_bench_done", outcome="ok", duration_s=result.duration)

        env = self.rclone_env()
        uploaded = 0
        for site, folder, files in self.local_backups():
            if self.stop.is_set():
                self.log.warning("backup_interrupted", outcome="interrupted")
                return
            if self._upload(site, folder, files, day, env):
                uploaded += 1
            else:
                failures += 1

        if not self.stop.is_set() and not self._prune(day, env):
            failures += 1
        self.log.event("info" if failures == 0 else "error", "backup_finished",
                       outcome="ok" if failures == 0 else "failed", sites=uploaded, failures=failures,
                       duration_s=time.monotonic() - start)

    def local_backups(self):
        """(site, backups folder, [file names]) for every site with files waiting in
        `<site>/private/backups`."""
        sites_dir = self.config.sites_dir
        try:
            entries = sorted(os.listdir(sites_dir))
        except OSError:
            return []
        found = []
        for site in entries:
            if not os.path.isfile(os.path.join(sites_dir, site, "site_config.json")):
                continue  # assets/, apps.txt and friends are not sites
            folder = os.path.join(sites_dir, site, "private", "backups")
            try:
                files = sorted(f for f in os.listdir(folder) if os.path.isfile(os.path.join(folder, f)))
            except OSError:
                continue
            if files:
                found.append((site, folder, files))
        return found

    def _upload(self, site, folder, files, day: date, env) -> bool:
        cfg = self.config
        dest = f"{REMOTE}:{cfg.backup_bucket}/{day.isoformat()}/{site}/"
        result = self.runner.run([cfg.rclone_bin, "copy", folder, dest, "--max-depth", "1"],
                                 cwd=cfg.bench_dir, timeout=UPLOAD_TIMEOUT, env=env, interruptible=True)
        if not result.ok:
            self.log.error("backup_upload", site=site, outcome="interrupted" if result.interrupted else "failed",
                           duration_s=result.duration,
                           error=error_message(self.log.redact, f"rclone exit {result.returncode}", result.output))
            return False
        removed = 0
        for name in files:  # only the files that existed before the copy started
            try:
                os.remove(os.path.join(folder, name))
                removed += 1
            except OSError:
                pass
        self.log.info("backup_upload", site=site, outcome="ok", files=removed, duration_s=result.duration)
        return True

    def _prune(self, day: date, env) -> bool:
        cfg = self.config
        listing = self.runner.run([cfg.rclone_bin, "lsf", f"{REMOTE}:{cfg.backup_bucket}", "--dirs-only"],
                                  cwd=cfg.bench_dir, timeout=LIST_TIMEOUT, env=env)
        if not listing.ok:
            self.log.error("backup_prune", outcome="failed",
                           error=error_message(self.log.redact, "rclone lsf failed", listing.output))
            return False
        ok = True
        for folder in expired_date_dirs(listing.stdout.splitlines(), day):
            if self.stop.is_set():
                return ok
            result = self.runner.run([cfg.rclone_bin, "purge", f"{REMOTE}:{cfg.backup_bucket}/{folder}"],
                                     cwd=cfg.bench_dir, timeout=PURGE_TIMEOUT, env=env)
            if result.ok:
                self.log.info("backup_prune", folder=folder, outcome="ok", duration_s=result.duration)
            else:
                ok = False
                self.log.error("backup_prune", folder=folder, outcome="failed",
                               error=error_message(self.log.redact, "rclone purge failed", result.output))
        return ok
