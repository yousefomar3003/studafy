# Toolchain image for the weekly Postgres restore-and-verify drill (ST-265,
# infra/terraform/modules/backup/restore_verify.tf). Not a reuse of infra/docker/migrations.Dockerfile
# — that image is a Bun runtime for db/migrations' own SQL migration tool and carries no psql/aws-cli
# binaries; this one needs exactly those two tools and nothing about the app's Bun workspace, so a
# separate minimal image is the KISS choice, not "one more Dockerfile to maintain".
#
# Build from the repo root, same convention as every other Dockerfile in this directory
# (infra/docker/README.md's "Why the build context is the repo root"):
#   docker build -f infra/docker/backup-verify.Dockerfile -t studafy/backup-verify .

FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client jq \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir --root-user-action=ignore awscli

RUN addgroup --system --gid 10001 app \
    && adduser --system --uid 10001 --gid 10001 --home /home/app app
USER app
WORKDIR /home/app

COPY --chown=app:app infra/docker/backup-verify/postgres-restore-verify.sh ./postgres-restore-verify.sh
RUN chmod +x ./postgres-restore-verify.sh

# No ENTRYPOINT/CMD hardcoded to one script: infra/terraform/modules/backup registers this image
# under a single ECS task definition and picks the script to run via the task's own `command` —
# today that's only postgres-restore-verify.sh, but the next restore-verify job this toolchain grows
# (see README.md's Known gaps) reuses the same image without a rebuild.
