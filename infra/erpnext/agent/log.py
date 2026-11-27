"""Structured logs: one JSON object per line on stdout (supervisord forwards it; Axiom ships it)."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone

from .redact import Redactor


class JsonLogger:
    def __init__(self, stream=None, redact: Redactor | None = None):
        self._stream = stream if stream is not None else sys.stdout
        self.redact = redact or Redactor()

    def event(self, level: str, event: str, **fields) -> None:
        record = {
            "time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "level": level,
            "event": event,
        }
        for key, value in fields.items():
            if value is None:
                continue
            if isinstance(value, float):
                value = round(value, 3)
            elif not isinstance(value, (int, bool)):
                # Defence in depth: callers never pass secrets, but command output and exception
                # text can carry them, so every string is scrubbed on the way out.
                value = self.redact(str(value))
            record[key] = value
        try:
            self._stream.write(json.dumps(record, ensure_ascii=False) + "\n")
            self._stream.flush()
        except (OSError, ValueError):
            pass  # a closed stdout must not take the agent down

    def info(self, event: str, **fields) -> None:
        self.event("info", event, **fields)

    def warning(self, event: str, **fields) -> None:
        self.event("warning", event, **fields)

    def error(self, event: str, **fields) -> None:
        self.event("error", event, **fields)
