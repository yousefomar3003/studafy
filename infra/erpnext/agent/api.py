"""The Studafy API's internal agent routes (`/api/internal/erpnext/...`), over urllib."""

from __future__ import annotations

import http.client
import json
import socket
import urllib.error
import urllib.request
from urllib.parse import quote

from . import __version__
from .runner import StopFlag

REQUEST_TIMEOUT = 30  # seconds, every call
REPORT_ATTEMPTS = 3  # a report after minutes of bench work is worth a few quick retries
REPORT_RETRY_BASE = 2.0  # seconds: 2, 4


class ApiError(Exception):
    def __init__(self, message: str, status: int | None = None, transient: bool = False):
        super().__init__(message)
        self.status = status
        self.transient = transient


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib would replay the bearer token to wherever a redirect points. Never follow one."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AgentApi:
    def __init__(self, base_url: str, token: str, *, stop=None, timeout: float = REQUEST_TIMEOUT):
        self._base = base_url.rstrip("/")
        self._token = token
        self._stop = stop if stop is not None else StopFlag()
        self._timeout = timeout
        self._opener = urllib.request.build_opener(_NoRedirect)

    # -- lists ---------------------------------------------------------------------------------

    def pending_sites(self) -> list:
        return self._sites("/sites/pending")

    def wake_sites(self) -> list:
        return self._sites("/sites/wake")

    def idle_sites(self) -> list:
        return self._sites("/sites/idle")

    # -- reports -------------------------------------------------------------------------------

    def report_created(self, site_id) -> None:
        self._report(site_id, "created")

    def report_failed(self, site_id, error: str) -> None:
        self._report(site_id, "failed", {"error": error})

    def report_woken(self, site_id) -> None:
        self._report(site_id, "woken")

    def report_slept(self, site_id) -> None:
        self._report(site_id, "slept")

    # -- transport -----------------------------------------------------------------------------

    def _sites(self, path: str) -> list:
        payload = self.request("GET", path)
        sites = payload.get("sites") if isinstance(payload, dict) else None
        if not isinstance(sites, list) or not all(isinstance(site, dict) for site in sites):
            raise ApiError(f"GET {path}: unexpected response shape", status=200)
        return sites

    def _report(self, site_id, action: str, body=None) -> None:
        path = f"/sites/{quote(str(site_id), safe='')}/{action}"
        attempt = 1
        while True:
            try:
                self.request("POST", path, body)
                return
            except ApiError as exc:
                if not exc.transient or attempt >= REPORT_ATTEMPTS:
                    raise
            delay = REPORT_RETRY_BASE * 2 ** (attempt - 1)
            if self._stop.wait(delay):
                raise ApiError(f"POST {path}: shutting down", transient=True)
            attempt += 1

    def request(self, method: str, path: str, body=None):
        url = self._base + path
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Authorization", f"Bearer {self._token}")
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", f"studafy-erpnext-agent/{__version__}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            raise ApiError(
                f"{method} {path}: HTTP {status}", status=status, transient=status >= 500 or status == 429
            ) from None
        except (urllib.error.URLError, socket.timeout, http.client.HTTPException, OSError) as exc:
            reason = getattr(exc, "reason", None) or exc
            raise ApiError(f"{method} {path}: {type(exc).__name__}: {reason}", transient=True) from None
        if not raw.strip():
            return None
        try:
            return json.loads(raw)
        except ValueError:
            raise ApiError(f"{method} {path}: response is not JSON", status=200, transient=True) from None
