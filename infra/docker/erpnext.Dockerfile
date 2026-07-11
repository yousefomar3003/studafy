# ERPNext + Frappe Education, on top of the official frappe/erpnext image.
#
# Build from the repo root, same convention as the other three Dockerfiles in this directory
# (infra/docker/README.md's "Why the build context is the repo root") — this one doesn't touch the
# Bun workspace, but it does need infra/deploy/erpnext/seed/, which only exists in a repo-root
# context:
#   docker build -f infra/docker/erpnext.Dockerfile -t studafy/erpnext .
#
# This image is used by the backend/websocket/queue/scheduler ECS services
# (infra/terraform/modules/erpnext) — every bench role that runs Python/Node bench commands. The
# frontend role deliberately does NOT use this image; it runs the stock upstream
# frappe/erpnext-nginx image unmodified, since nginx doesn't run bench and doesn't need the
# Education app installed (see modules/erpnext/README.md).
#
# No custom build/runtime split like api/realtime/workers/web's Dockerfiles: there is no slim
# final artifact to copy things into here — frappe/erpnext's own image is already the runtime,
# `bench get-app` layers a Python/Node app onto it in place, and every role that uses this image
# needs the full bench, not a trimmed subset of it.

ARG ERPNEXT_VERSION=version-15

FROM frappe/erpnext:${ERPNEXT_VERSION}

USER frappe
WORKDIR /home/frappe/frappe-bench

# The officially documented way to layer a third-party Frappe app onto a prebuilt bench image
# without rebuilding it from frappe_docker's own multi-stage pipeline: `get-app` fetches the app's
# source and installs its Python requirements into the bench's shared virtualenv; `build --app`
# compiles its front-end assets. frappe/education dropped the plain "version-15" branch in favor
# of per-minor branches, so we pin to the latest v15 line (version-15.2) to stay on the same major
# line as ERPNEXT_VERSION without drifting onto an incompatible Frappe framework version.
RUN bench get-app education --branch version-15.2 https://github.com/frappe/education && \
    bench build --app education

# infra/deploy/scripts/erpnext-new-site.sh's --seed flag runs `bench --site <hostname> execute
# erpnext_seed.load_fixtures` against whichever role picks up the run-task override — placed on
# PYTHONPATH (below) rather than installed as a proper bench app, since it's a one-shot loader
# script, not a Frappe app with its own doctypes/migrations.
COPY --chown=frappe:frappe infra/deploy/erpnext/seed/ /home/frappe/frappe-bench/erpnext_seed/
ENV PYTHONPATH=/home/frappe/frappe-bench:${PYTHONPATH}

# No EXPOSE, no ENTRYPOINT/CMD override: modules/erpnext's task-definition templates set the
# actual command per role (gunicorn for backend, node for websocket, bench worker/schedule for
# queue/scheduler) — this image is a shared base for all four, not a single-role image the way
# api/realtime/workers/web's Dockerfiles are.
