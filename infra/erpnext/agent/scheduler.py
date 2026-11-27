"""A single-threaded loop over the agent's jobs, so backups and site creation never overlap on the
2 GB machine. A job that hits API trouble backs off on its own; the others keep their schedule."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

from .api import ApiError

BACKOFF_BASE = 15.0  # seconds after the first failure: 15, 30, 60, 120, 240, 300, 300...
BACKOFF_CAP = 300.0
SLOW_RETRY = 300.0  # 401 (wrong token) and 404 (agent routes not mounted): retry, but slowly
IDLE_POLL = 60.0  # longest single sleep, so a changed clock is noticed within a minute


def backoff_delay(failures: int, base: float = BACKOFF_BASE, cap: float = BACKOFF_CAP) -> float:
    if failures <= 0:
        return 0.0
    return min(cap, base * 2 ** min(failures - 1, 16))


def every(seconds: float) -> Callable[[float], float]:
    return lambda now: now + seconds


@dataclass
class Job:
    name: str
    run: Callable[[], None]
    next_due: Callable[[float], float]  # given the time a run finished, when the next one is due
    next_run: float = 0.0
    failures: int = 0
    retry_errors: bool = True  # False: an unexpected error waits for the next regular run


class Scheduler:
    def __init__(self, jobs, log, stop, clock=time.time):
        self.jobs = list(jobs)
        self.log = log
        self.stop = stop
        self.clock = clock

    def run_forever(self) -> None:
        while not self.stop.is_set():
            now = self.clock()
            due = [job for job in self.jobs if job.next_run <= now]
            if not due:
                soonest = min(job.next_run for job in self.jobs)
                self.stop.wait(min(IDLE_POLL, max(0.5, soonest - now)))
                continue
            self.run_job(min(due, key=lambda job: job.next_run))

    def run_job(self, job: Job) -> None:
        start = self.clock()
        try:
            job.run()
        except ApiError as exc:
            now = self.clock()
            if exc.status == 401:
                job.next_run = now + SLOW_RETRY
                self.log.error("api_unauthorized", job=job.name, outcome="retry", status=401,
                               retry_in_s=SLOW_RETRY,
                               detail="the API rejected ERPNEXT_AGENT_TOKEN; check it matches the API's")
            elif exc.status == 404:
                job.next_run = now + SLOW_RETRY
                self.log.error("api_not_found", job=job.name, outcome="retry", status=404,
                               retry_in_s=SLOW_RETRY,
                               detail="agent routes not mounted; is ERPNEXT_AGENT_TOKEN set on the API?")
            elif exc.transient:
                job.failures += 1
                delay = backoff_delay(job.failures)
                job.next_run = now + delay
                self.log.warning("api_unavailable", job=job.name, outcome="retry", status=exc.status,
                                 failures=job.failures, retry_in_s=delay, error=str(exc))
            else:
                job.failures = 0
                job.next_run = job.next_due(now)
                self.log.error("api_error", job=job.name, outcome="failed", status=exc.status, error=str(exc))
            return
        except Exception as exc:  # never let one bad run kill the agent
            now = self.clock()
            if job.retry_errors:
                job.failures += 1
                job.next_run = now + backoff_delay(job.failures)
            else:
                job.next_run = job.next_due(now)
            self.log.error("job_error", job=job.name, outcome="failed", error=f"{type(exc).__name__}: {exc}",
                           duration_s=now - start)
            return
        job.failures = 0
        job.next_run = job.next_due(self.clock())
