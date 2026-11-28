"""The agent's settings, read once from the environment (Fly secrets on the ERPNext machine)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlparse

from .redact import MIN_SECRET_LENGTH

BENCH_DIR = "/home/frappe/frappe-bench"

REQUIRED = (
    "STUDAFY_API_URL",
    "ERPNEXT_AGENT_TOKEN",
    "MARIADB_ROOT_PASSWORD",
    "ERPNEXT_ADMIN_PASSWORD",
    "STUDAFY_ERPNEXT_API_KEY",
    "STUDAFY_ERPNEXT_WEBHOOK_SECRET",
)


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    api_url: str
    agent_token: str
    mariadb_root_password: str
    admin_password: str
    erpnext_api_key: str
    webhook_secret: str
    backup_bucket: str = ""
    backup_endpoint: str = ""
    backup_access_key_id: str = ""
    backup_secret_access_key: str = ""
    # Absolute paths on purpose: `sites` is a symlink to /data/sites, so a relative `../env` from
    # the sites directory resolves (physically) to /data/env, and bench cannot find its bench root
    # from there either. Bench commands therefore run from the bench root; provision from `sites`.
    bench_dir: str = BENCH_DIR
    bench_bin: str = "bench"
    rclone_bin: str = "rclone"

    @property
    def sites_dir(self) -> str:
        return os.path.join(self.bench_dir, "sites")

    @property
    def python_bin(self) -> str:
        return os.path.join(self.bench_dir, "env", "bin", "python")

    @property
    def agent_api_base(self) -> str:
        return self.api_url.rstrip("/") + "/api/internal/erpnext"

    @property
    def backups_enabled(self) -> bool:
        return bool(self.backup_bucket)

    def short_secrets(self) -> list[str]:
        """Names of secrets too short to scrub from output (see redact.MIN_SECRET_LENGTH)."""
        named = {
            "ERPNEXT_AGENT_TOKEN": self.agent_token,
            "MARIADB_ROOT_PASSWORD": self.mariadb_root_password,
            "ERPNEXT_ADMIN_PASSWORD": self.admin_password,
            "STUDAFY_ERPNEXT_API_KEY": self.erpnext_api_key,
            "STUDAFY_ERPNEXT_WEBHOOK_SECRET": self.webhook_secret,
            "BACKUP_S3_SECRET_ACCESS_KEY": self.backup_secret_access_key,
        }
        short = [name for name, value in named.items() if value and len(value) < MIN_SECRET_LENGTH]
        api_key, _, api_secret = self.erpnext_api_key.partition(":")
        if "STUDAFY_ERPNEXT_API_KEY" not in short and min(len(api_key), len(api_secret)) < MIN_SECRET_LENGTH:
            short.append("STUDAFY_ERPNEXT_API_KEY")
        return short

    def secret_values(self) -> list[str]:
        """Every value that must never reach a log line or a `/failed` error."""
        api_key, _, api_secret = self.erpnext_api_key.partition(":")
        values = [
            self.agent_token,
            self.mariadb_root_password,
            self.admin_password,
            self.erpnext_api_key,
            api_key,
            api_secret,
            self.webhook_secret,
            self.backup_access_key_id,
            self.backup_secret_access_key,
        ]
        return [value for value in values if value]

    @classmethod
    def from_env(cls, env=None) -> "Config":
        env = os.environ if env is None else env
        missing = [name for name in REQUIRED if not env.get(name, "").strip()]
        if missing:
            raise ConfigError("missing required environment variables: " + ", ".join(missing))
        api_url = env["STUDAFY_API_URL"].strip()
        parsed = urlparse(api_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ConfigError("STUDAFY_API_URL must be an http(s) URL")
        if ":" not in env["STUDAFY_ERPNEXT_API_KEY"]:
            raise ConfigError("STUDAFY_ERPNEXT_API_KEY must be <api_key>:<api_secret>")
        bucket = env.get("BACKUP_S3_BUCKET", "").strip()
        config = cls(
            api_url=api_url,
            agent_token=env["ERPNEXT_AGENT_TOKEN"].strip(),
            mariadb_root_password=env["MARIADB_ROOT_PASSWORD"],
            admin_password=env["ERPNEXT_ADMIN_PASSWORD"],
            erpnext_api_key=env["STUDAFY_ERPNEXT_API_KEY"],
            webhook_secret=env["STUDAFY_ERPNEXT_WEBHOOK_SECRET"],
            backup_bucket=bucket,
            backup_endpoint=env.get("BACKUP_S3_ENDPOINT", "").strip(),
            backup_access_key_id=env.get("BACKUP_S3_ACCESS_KEY_ID", "").strip(),
            backup_secret_access_key=env.get("BACKUP_S3_SECRET_ACCESS_KEY", "").strip(),
            bench_dir=env.get("ERPNEXT_AGENT_BENCH_DIR", "").strip() or BENCH_DIR,
        )
        if bucket:
            unset = [
                name
                for name in ("BACKUP_S3_ENDPOINT", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY")
                if not env.get(name, "").strip()
            ]
            if unset:
                raise ConfigError("BACKUP_S3_BUCKET is set but these are not: " + ", ".join(unset))
        return config
