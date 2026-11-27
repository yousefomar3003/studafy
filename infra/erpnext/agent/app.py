"""Entry point: `python -m erpnext_agent [run|once|backup]`."""

from __future__ import annotations

import argparse
import signal
import time

from . import __version__
from .api import AgentApi
from .backup import Backup
from .config import Config, ConfigError
from .log import JsonLogger
from .redact import MIN_SECRET_LENGTH, Redactor
from .runner import Runner, StopFlag
from .scheduler import Job, Scheduler, every
from .sites import SiteJobs

PENDING_INTERVAL = 60
WAKE_INTERVAL = 60
IDLE_INTERVAL = 24 * 60 * 60


def build(config: Config, log: JsonLogger, stop: StopFlag, runner=None, api=None, clock=time.time):
    """The scheduler and its jobs, with every dependency injectable for tests."""
    runner = runner or Runner(stop)
    api = api or AgentApi(config.agent_api_base, config.agent_token, stop=stop)
    sites = SiteJobs(config, api, runner, log, stop)
    backup = Backup(config, runner, log, stop)
    now = clock()
    jobs = [
        Job("pending", sites.run_pending, every(PENDING_INTERVAL), next_run=now),
        Job("wake", sites.run_wake, every(WAKE_INTERVAL), next_run=now),
        Job("idle", sites.run_idle, every(IDLE_INTERVAL), next_run=now),
        Job("backup", backup.run, backup.next_run, next_run=backup.next_run(now), retry_errors=False),
    ]
    return Scheduler(jobs, log, stop, clock=clock)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m erpnext_agent", description="Studafy ERPNext site agent")
    parser.add_argument(
        "command",
        nargs="?",
        default="run",
        choices=("run", "once", "backup"),
        help="run: the loop (default, what supervisord starts); once: one pending, wake and idle "
        "pass, then exit; backup: one backup now, then exit",
    )
    args = parser.parse_args(argv)

    log = JsonLogger()
    try:
        config = Config.from_env()
    except ConfigError as exc:
        log.error("config_invalid", outcome="exit", error=str(exc))
        return 2
    log.redact = Redactor(config.secret_values())

    stop = StopFlag()

    def on_signal(signum, _frame):
        stop.set(signal.Signals(signum).name)  # no logging here: see StopFlag

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    short = config.short_secrets()
    if short:
        log.warning("secret_too_short", outcome="not_scrubbed", detail=", ".join(short),
                    error=f"values shorter than {MIN_SECRET_LENGTH} characters cannot be scrubbed from logs")

    scheduler = build(config, log, stop)
    log.info("agent_started", version=__version__, command=args.command, api=config.agent_api_base,
             backups=config.backups_enabled)
    if args.command == "run":
        scheduler.run_forever()
    else:
        names = ("backup",) if args.command == "backup" else ("pending", "wake", "idle")
        for job in scheduler.jobs:
            if job.name in names and not stop.is_set():
                scheduler.run_job(job)
    log.info("agent_stopped", outcome="ok", signal=stop.signal_name)
    return 0
