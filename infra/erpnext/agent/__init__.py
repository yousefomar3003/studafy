"""The ERPNext site agent: creates, wakes, sleeps and backs up the Frappe sites on this machine.

It runs next to the bench on the ERPNext Fly machine (supervisord program `agent`, started as
`python -m erpnext_agent`) and only makes outbound calls to the Studafy API's internal agent routes
(`/api/internal/erpnext/...`). Standard library only: the bench's virtualenv is not guaranteed to
have anything else. See README.md in this directory.
"""

__version__ = "1.0.0"
