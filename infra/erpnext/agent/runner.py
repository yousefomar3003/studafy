"""Running bench, provision and rclone as subprocesses, always with a timeout."""

from __future__ import annotations

import os
import signal
import subprocess
import time
from dataclasses import dataclass


class StopFlag:
    """Set by SIGTERM/SIGINT. A plain attribute, not threading.Event: Event.set() takes a lock, and
    taking it from a signal handler that interrupted the same thread can deadlock."""

    def __init__(self):
        self._set = False
        self.signal_name = None

    def set(self, signal_name=None) -> None:
        self.signal_name = signal_name
        self._set = True

    def is_set(self) -> bool:
        return self._set

    def wait(self, seconds: float) -> bool:
        """Sleep up to `seconds`, returning early (True) once the flag is set."""
        deadline = time.monotonic() + max(0.0, seconds)
        while not self._set:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(1.0, remaining))
        return self._set


def child_env() -> dict:
    """The agent's environment minus its own API token, which no child process needs."""
    env = dict(os.environ)
    env.pop("ERPNEXT_AGENT_TOKEN", None)
    return env


@dataclass
class Result:
    returncode: int | None
    stdout: str
    stderr: str
    duration: float
    timed_out: bool = False
    interrupted: bool = False

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out and not self.interrupted

    @property
    def output(self) -> str:
        """What to show for a failure: stderr, or stdout when the command wrote its error there."""
        return self.stderr.strip() or self.stdout.strip()


class Runner:
    """`interruptible` commands are stopped on shutdown; the rest (seconds long) run to the end."""

    def __init__(self, stop: StopFlag, grace: float = 10.0):
        self._stop = stop
        self._grace = grace

    def run(self, argv, *, cwd, timeout, env=None, interruptible=False) -> Result:
        start = time.monotonic()
        try:
            proc = subprocess.Popen(
                list(argv),
                cwd=cwd,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                start_new_session=True,  # its own process group, so the whole tree can be stopped
            )
        except OSError as exc:
            return Result(None, "", f"could not start {os.path.basename(argv[0])}: {exc}", 0.0)

        deadline = start + timeout
        timed_out = interrupted = False
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            try:
                stdout, stderr = proc.communicate(timeout=min(1.0, remaining))
                return Result(proc.returncode, stdout, stderr, time.monotonic() - start)
            except subprocess.TimeoutExpired:
                if interruptible and self._stop.is_set():
                    interrupted = True
                    break

        stdout, stderr = self._terminate(proc)
        return Result(
            proc.returncode,
            stdout or "",
            stderr or "",
            time.monotonic() - start,
            timed_out=timed_out,
            interrupted=interrupted,
        )

    def _terminate(self, proc):
        self._signal_group(proc, signal.SIGTERM)
        try:
            return proc.communicate(timeout=self._grace)
        except subprocess.TimeoutExpired:
            self._signal_group(proc, signal.SIGKILL)
            return proc.communicate()

    @staticmethod
    def _signal_group(proc, sig) -> None:
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
