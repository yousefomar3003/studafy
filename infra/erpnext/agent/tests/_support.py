"""Shared test helpers: the agent loaded under its production package name, a fake agent API on a
local http.server, and a fake subprocess runner. No Frappe, no network beyond 127.0.0.1."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_agent():
    """The image copies infra/erpnext/agent/ to erpnext_agent/; import it under that name."""
    if "erpnext_agent" in sys.modules:
        return sys.modules["erpnext_agent"]
    spec = importlib.util.spec_from_file_location(
        "erpnext_agent", os.path.join(AGENT_DIR, "__init__.py"), submodule_search_locations=[AGENT_DIR]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["erpnext_agent"] = module
    spec.loader.exec_module(module)
    return module


_load_agent()

from erpnext_agent.config import Config  # noqa: E402
from erpnext_agent.log import JsonLogger  # noqa: E402
from erpnext_agent.redact import Redactor  # noqa: E402
from erpnext_agent.runner import Result, StopFlag  # noqa: E402

SECRETS = {
    "agent_token": "tok-AGENT-0a1b2c3d4e",
    "mariadb_root_password": "db-ROOT-pw-5f6g7h",
    "admin_password": "admin-PW-8i9j0k",
    "erpnext_api_key": "apikeyID1234:apisecretXYZ987",
    "webhook_secret": "hook-SECRET-lmnop",
}


def make_config(bench_dir: str, api_url: str = "http://127.0.0.1:9", **overrides) -> Config:
    values = dict(SECRETS, api_url=api_url, bench_dir=bench_dir)
    values.update(overrides)
    os.makedirs(os.path.join(bench_dir, "sites"), exist_ok=True)
    return Config(**values)


class CapturingLogger(JsonLogger):
    def __init__(self, config: Config | None = None):
        self.buffer = io.StringIO()
        super().__init__(stream=self.buffer, redact=Redactor(config.secret_values() if config else ()))

    @property
    def records(self) -> list:
        return [json.loads(line) for line in self.buffer.getvalue().splitlines()]

    def events(self, name: str) -> list:
        return [record for record in self.records if record["event"] == name]


def ok(stdout: str = "", stderr: str = "") -> Result:
    return Result(0, stdout, stderr, 0.01)


def failed(code: int = 1, stdout: str = "", stderr: str = "") -> Result:
    return Result(code, stdout, stderr, 0.01)


class Call:
    def __init__(self, argv, cwd, timeout, env, interruptible):
        self.argv = list(argv)
        self.cwd = cwd
        self.timeout = timeout
        self.env = env or {}
        self.interruptible = interruptible

    def has(self, *tokens) -> bool:
        return all(token in self.argv for token in tokens)


class FakeRunner:
    """Answers commands by the first rule whose tokens all appear in argv; default success."""

    def __init__(self):
        self.calls: list = []
        self._rules: list = []

    def on(self, *tokens, result: Result | None = None, effect=None) -> "FakeRunner":
        self._rules.append((tokens, result, effect))
        return self

    def run(self, argv, *, cwd, timeout, env=None, interruptible=False) -> Result:
        call = Call(argv, cwd, timeout, env, interruptible)
        self.calls.append(call)
        for tokens, result, effect in self._rules:
            if call.has(*tokens):
                if effect:
                    effect(call)
                return result or ok()
        return ok()

    def steps(self) -> list:
        """A readable name per call: the bench subcommand, provision, or the rclone verb."""
        names = []
        for call in self.calls:
            argv = call.argv
            if "erpnext_seed.provision" in argv:
                names.append("provision")
            elif os.path.basename(argv[0]) == "rclone":
                names.append("rclone " + argv[1])
            elif argv[1] == "--site":
                names.append(" ".join(argv[3:]))
            else:
                names.append(argv[1])
        return names


class FakeApi:
    """The agent routes on 127.0.0.1, with scripted responses per (method, path)."""

    def __init__(self, token: str = SECRETS["agent_token"]):
        self.token = token
        self.requests: list = []
        self._responses: dict = {}
        self._lock = threading.Lock()
        api = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                api._handle(self, "GET")

            def do_POST(self):
                api._handle(self, "POST")

            def log_message(self, *_args):
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def respond(self, method: str, path: str, *responses) -> None:
        """Queue (status, body) answers for a route; the last one repeats."""
        self._responses[(method, path)] = list(responses)

    def calls(self, method: str | None = None, path: str | None = None) -> list:
        return [
            r for r in self.requests if (method is None or r["method"] == method) and (path is None or r["path"] == path)
        ]

    def _handle(self, handler, method: str) -> None:
        length = int(handler.headers.get("Content-Length") or 0)
        raw = handler.rfile.read(length) if length else b""
        prefix = "/api/internal/erpnext"
        path = handler.path[len(prefix):] if handler.path.startswith(prefix) else handler.path
        with self._lock:
            self.requests.append(
                {
                    "method": method,
                    "path": path,
                    "auth": handler.headers.get("Authorization"),
                    "body": json.loads(raw) if raw else None,
                }
            )
            queue = self._responses.get((method, path))
            if handler.headers.get("Authorization") != f"Bearer {self.token}":
                status, body = 401, {"title": "Unauthorized"}
            elif queue:
                status, body = queue.pop(0) if len(queue) > 1 else queue[0]
            elif method == "GET":
                status, body = 200, {"sites": []}
            else:
                status, body = 204, None
        data = b"" if body is None else json.dumps(body).encode()
        handler.send_response(status)
        if data:
            handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        if data:
            handler.wfile.write(data)


class InstantStop(StopFlag):
    """A stop flag whose waits return immediately, recording how long they were asked to sleep."""

    def __init__(self):
        super().__init__()
        self.waits: list = []

    def wait(self, seconds: float) -> bool:
        self.waits.append(seconds)
        return self.is_set()
