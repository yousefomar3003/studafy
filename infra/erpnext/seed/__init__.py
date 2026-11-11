"""Makes this directory importable as `erpnext_seed` once infra/docker/erpnext.Dockerfile copies
it onto PYTHONPATH — `bench --site <hostname> execute erpnext_seed.load_fixtures` resolves to the
function re-exported below."""

from .load_fixtures import load_fixtures  # noqa: F401
