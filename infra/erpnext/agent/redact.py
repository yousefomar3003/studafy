"""Scrubbing secret values out of command output before it is logged or reported."""

from __future__ import annotations

import re
from urllib.parse import quote

REDACTED = "[redacted]"
ERROR_LIMIT = 2000  # POST /sites/{id}/failed accepts 1-2000 characters
MIN_SECRET_LENGTH = 4  # shorter values would shred every message; config warns about them instead


class Redactor:
    def __init__(self, secrets=()):
        variants = set()
        for secret in secrets:
            if not secret or len(secret) < MIN_SECRET_LENGTH:
                continue
            variants.add(secret)
            variants.add(quote(secret, safe=""))  # as it would appear inside a URL or form body
        # One pass over the text, longest secret first, so a secret that contains another is
        # replaced whole and the replacement itself is never scanned again.
        ordered = sorted(variants, key=len, reverse=True)
        self._pattern = re.compile("|".join(re.escape(value) for value in ordered)) if ordered else None

    def __call__(self, text: str) -> str:
        if self._pattern is None:
            return text
        return self._pattern.sub(REDACTED, text)


def error_message(redact: Redactor, header: str, output: str, limit: int = ERROR_LIMIT) -> str:
    """`header: <tail of output>`, scrubbed, at most `limit` characters.

    Scrubbing happens before truncation, so a cut can never leave part of a secret behind.
    """
    header = redact(header.strip()) or "error"
    body = redact(output.strip())
    if not body:
        return header[:limit]
    room = limit - len(header) - 2
    if room <= 3:
        return header[:limit]
    if len(body) > room:
        body = "..." + body[-(room - 3):]
    return f"{header}: {body}"
