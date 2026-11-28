"""Site creation (pending), waking and sleeping: the bench side of the agent API.

Commands mirror apps/api/scripts/init-local-erpnext.ts and the plan's "Site creation" contract.
Values go as `--option=value`, so a company name or password that starts with "-" is never read as
an option. Nothing here logs a command line: `bench new-site` takes passwords as arguments.
"""

from __future__ import annotations

import os
import re
import time

from .api import ApiError
from .redact import error_message
from .runner import child_env

NEW_SITE_TIMEOUT = 15 * 60
PROVISION_TIMEOUT = 15 * 60
DROP_SITE_TIMEOUT = 10 * 60
SCHEDULER_TIMEOUT = 2 * 60

# A DNS hostname (`<slug>.erpnext.studafy.com`): it becomes a directory under sites/, so nothing
# that could step outside it ("..", "/") gets through.
SITE_NAME_RE = re.compile(
    r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
)
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
COUNTRY_RE = re.compile(r"^[A-Za-z]{2}$")

# Written before `bench new-site` and removed after it succeeds. A site directory with this marker
# beside it is a half-made site (new-site failed, timed out, or the machine stopped mid-way): it is
# dropped and created again. A site directory without it was created before and only the report
# was lost, so new-site is skipped.
CREATING_MARKER = ".erpnext-agent-creating.{site}"


class StepFailed(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class Interrupted(Exception):
    """Shutdown stopped a long step. The site is left for the next start to pick up again."""


class SiteJobs:
    def __init__(self, config, api, runner, log, stop):
        self.config = config
        self.api = api
        self.runner = runner
        self.log = log
        self.stop = stop

    # -- pending -------------------------------------------------------------------------------

    def run_pending(self) -> None:
        sites = self.api.pending_sites()
        if sites:
            self.log.info("pending_sites", count=len(sites))
        for site in sites:
            if self.stop.is_set():
                break
            self.create_site(site)

    def create_site(self, site: dict) -> None:
        site_id = site.get("id")
        name = site.get("site_name")
        if site_id in (None, ""):
            self.log.error("site_failed", site=name, outcome="failed", error="pending site has no id")
            return
        start = time.monotonic()
        try:
            fields = self._validate(site)
            self._create(fields)
        except Interrupted:
            self.log.warning("site_interrupted", site=name, site_id=site_id, outcome="interrupted",
                             duration_s=time.monotonic() - start)
            return
        except (StepFailed, OSError) as exc:
            message = exc.message if isinstance(exc, StepFailed) else error_message(
                self.log.redact, "filesystem error", str(exc))
            self.log.error("site_failed", site=name, site_id=site_id, outcome="failed",
                           duration_s=time.monotonic() - start, error=message)
            self._report(self.api.report_failed, site_id, name, message)
            return
        if self._report(self.api.report_created, site_id, name):
            self.log.info("site_created", site=name, site_id=site_id, outcome="ok",
                          duration_s=time.monotonic() - start)

    def _validate(self, site: dict) -> dict:
        name = site.get("site_name")
        if not isinstance(name, str) or not SITE_NAME_RE.match(name):
            raise StepFailed("invalid site_name")
        fields = {
            "site_name": name,
            "company_name": site.get("company_name"),
            "company_abbr": site.get("company_abbr"),
            "school_id": site.get("school_id"),
            "currency_code": site.get("currency_code") or "JOD",
            "country_code": site.get("country_code") or "JO",
        }
        for key in ("company_name", "company_abbr", "school_id"):
            if not isinstance(fields[key], str) or not fields[key].strip():
                raise StepFailed(f"missing {key}")
        if not CURRENCY_RE.match(str(fields["currency_code"])):
            raise StepFailed("invalid currency_code")
        if not COUNTRY_RE.match(str(fields["country_code"])):
            raise StepFailed("invalid country_code")
        return fields

    def _create(self, fields: dict) -> None:
        cfg = self.config
        site = fields["site_name"]
        site_dir = os.path.join(cfg.sites_dir, site)
        marker = os.path.join(cfg.sites_dir, CREATING_MARKER.format(site=site))

        if os.path.exists(marker):
            if os.path.isdir(site_dir):
                self.log.warning("site_partial", site=site, outcome="dropping",
                                 detail="an earlier new-site did not finish")
                self._step(site, "drop-site", [
                    cfg.bench_bin, "drop-site", site,
                    f"--db-root-password={cfg.mariadb_root_password}",
                    "--no-backup", "--force",
                ], cwd=cfg.bench_dir, timeout=DROP_SITE_TIMEOUT)
            os.remove(marker)

        if os.path.isdir(site_dir):
            self.log.info("site_step", site=site, step="new-site", outcome="skipped",
                          detail="site directory exists")
        else:
            with open(marker, "w") as handle:
                handle.write("bench new-site in progress\n")
            self._step(site, "new-site", [
                cfg.bench_bin, "new-site", site,
                "--mariadb-user-host-login-scope=localhost",
                f"--db-root-password={cfg.mariadb_root_password}",
                f"--admin-password={cfg.admin_password}",
                "--install-app", "erpnext",
                "--install-app", "education",
            ], cwd=cfg.bench_dir, timeout=NEW_SITE_TIMEOUT, interruptible=True)
            os.remove(marker)

        env = child_env()
        env["STUDAFY_ERPNEXT_API_KEY"] = cfg.erpnext_api_key
        env["STUDAFY_ERPNEXT_WEBHOOK_SECRET"] = cfg.webhook_secret
        self._step(site, "provision", [
            cfg.python_bin, "-m", "erpnext_seed.provision", site, "setup",
            f"--company={fields['company_name']}",
            f"--abbr={fields['company_abbr']}",
            f"--currency={fields['currency_code']}",
            f"--country-code={fields['country_code']}",
            f"--school-id={fields['school_id']}",
            f"--api-url={cfg.api_url}",
        ], cwd=cfg.sites_dir, timeout=PROVISION_TIMEOUT, env=env, interruptible=True)

        # New sites start asleep; the API asks for a wake on the school's first finance request.
        self._step(site, "disable-scheduler", [cfg.bench_bin, "--site", site, "disable-scheduler"],
                   cwd=cfg.bench_dir, timeout=SCHEDULER_TIMEOUT)

    # -- wake and sleep ------------------------------------------------------------------------

    def run_wake(self) -> None:
        self._toggle(self.api.wake_sites(), "enable-scheduler", self.api.report_woken, "site_woken")

    def run_idle(self) -> None:
        self._toggle(self.api.idle_sites(), "disable-scheduler", self.api.report_slept, "site_slept")

    def _toggle(self, sites, command: str, report, event: str) -> None:
        for site in sites:
            if self.stop.is_set():
                break
            site_id, name = site.get("id"), site.get("site_name")
            if site_id in (None, "") or not isinstance(name, str) or not SITE_NAME_RE.match(name):
                self.log.error(event, site=name, site_id=site_id, outcome="failed",
                               error="invalid site in API response")
                continue
            start = time.monotonic()
            try:
                self._step(name, command, [self.config.bench_bin, "--site", name, command],
                           cwd=self.config.bench_dir, timeout=SCHEDULER_TIMEOUT)
            except StepFailed as exc:
                self.log.error(event, site=name, site_id=site_id, outcome="failed",
                               duration_s=time.monotonic() - start, error=exc.message)
                continue
            if self._report(report, site_id, name):
                self.log.info(event, site=name, site_id=site_id, outcome="ok",
                              duration_s=time.monotonic() - start)

    # -- helpers -------------------------------------------------------------------------------

    def _step(self, site, step, argv, *, cwd, timeout, env=None, interruptible=False) -> None:
        result = self.runner.run(argv, cwd=cwd, timeout=timeout,
                                 env=env if env is not None else child_env(),
                                 interruptible=interruptible)
        if result.interrupted:
            self.log.warning("site_step", site=site, step=step, outcome="interrupted",
                             duration_s=result.duration)
            raise Interrupted()
        if result.ok:
            self.log.info("site_step", site=site, step=step, outcome="ok", duration_s=result.duration)
            return
        if result.timed_out:
            header = f"{step} timed out after {timeout}s"
        elif result.returncode is None:
            header = f"{step} could not start"
        else:
            header = f"{step} failed (exit {result.returncode})"
        message = error_message(self.log.redact, header, result.output)
        self.log.warning("site_step", site=site, step=step, outcome="failed", duration_s=result.duration)
        raise StepFailed(message)

    def _report(self, report, site_id, name, *args) -> bool:
        try:
            report(site_id, *args)
            return True
        except ApiError as exc:
            self.log.error("report_failed", site=name, site_id=site_id, outcome="failed",
                           status=exc.status, error=str(exc))
            return False
