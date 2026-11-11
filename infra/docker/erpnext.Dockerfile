# ERPNext + Frappe Education, on top of the official frappe/erpnext image.
#
# Build from the repo root, same convention as the other three Dockerfiles in this directory
# (infra/docker/README.md's "Why the build context is the repo root") — this one doesn't touch the
# Bun workspace, but it does need infra/erpnext/seed/, which only exists in a repo-root
# context:
#   docker build -f infra/docker/erpnext.Dockerfile -t studafy/erpnext .
#
# This image is every bench role that runs Python/Node bench commands (backend, websocket, queue,
# scheduler; see db/compose.yml for the local stack). The frontend role deliberately does NOT use
# this image; it runs the stock upstream frappe/erpnext-nginx image unmodified, since nginx doesn't
# run bench and doesn't need the Education app installed.
#
# No custom build/runtime split like api/realtime/workers/web's Dockerfiles: there is no slim
# final artifact to copy things into here — frappe/erpnext's own image is already the runtime,
# `bench get-app` layers a Python/Node app onto it in place, and every role that uses this image
# needs the full bench, not a trimmed subset of it.

# Pinned by digest, not just the version-15 tag: upstream republishes that tag in place, and a
# republish on 2026-09-28 grew the base enough to break this image's 3072MB CI size budget with no
# change on our side. The digest makes builds reproducible; Renovate proposes each new upstream
# digest as its own PR, where the size budget and scan run before it can merge.
FROM frappe/erpnext:version-15@sha256:de8e0068467b4ea5a9d1b0a7c07e37b1ed8d2ea8d2f9d02c316bfd4d5a80f5f3

USER frappe
WORKDIR /home/frappe/frappe-bench

# The officially documented way to layer a third-party Frappe app onto a prebuilt bench image
# without rebuilding it from frappe_docker's own multi-stage pipeline: `get-app` fetches the app's
# source and installs its Python requirements into the bench's shared virtualenv; `build --app`
# compiles its front-end assets. frappe/education dropped the plain "version-15" branch in favor
# of per-minor branches, so we pin to the latest v15 line (version-15.2) to stay on the same major
# line as the base image without drifting onto an incompatible Frappe framework version.
# line as ERPNEXT_VERSION without drifting onto an incompatible Frappe framework version.
#
# The trailing rm drops what only the build needed — the pip/yarn/npm download caches and the
# app's git history (frappe_docker's own images strip apps' .git the same way). It has to be in
# this same RUN: deleting them in a later layer would still ship them in this one. Keeps the image
# under containers.yml's size budget, which the floating base tag above slowly grows into.
RUN bench get-app education --branch version-15.2 https://github.com/frappe/education && \
    bench build --app education && \
    rm -rf /home/frappe/.cache /home/frappe/.npm apps/education/.git

# Seeding a demo site runs `bench --site <hostname> execute erpnext_seed.load_fixtures` (see
# infra/erpnext/seed/README.md) — placed on
# PYTHONPATH (below) rather than installed as a proper bench app, since it's a one-shot loader
# script, not a Frappe app with its own doctypes/migrations.
COPY --chown=frappe:frappe infra/erpnext/seed/ /home/frappe/frappe-bench/erpnext_seed/
ENV PYTHONPATH=/home/frappe/frappe-bench

# No EXPOSE, no ENTRYPOINT/CMD override: the caller (db/compose.yml locally) sets the actual
# command per role (gunicorn for backend, node for websocket, bench worker/schedule for
# queue/scheduler) — this image is a shared base for all four, not a single-role image the way
# api/realtime/workers/web's Dockerfiles are.
