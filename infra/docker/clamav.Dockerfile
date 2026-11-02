# ClamAV (clamd + freshclam), with this repo's own settings baked in — the malware scanner the
# workers' file-scan queue streams every uploaded object through (apps/workers/src/queues/scan).
#
# Build from the repo root, same convention as every other Dockerfile in this directory
# (infra/docker/README.md's "Why the build context is the repo root"):
#   docker build -f infra/docker/clamav.Dockerfile -t studafy/clamav .
#
# Runs as a sidecar container in the workers ECS task (infra/deploy/ecs/workers/
# task-definition.json.tpl). Under awsvpc networking the task's containers share one network
# namespace, so the workers reach clamd on 127.0.0.1:3310 (CLAMAV_HOST) and clamd binds only there:
# nothing outside the task can submit a scan. That binding also means a plain `docker run -p 3310`
# of this image cannot be reached from the host — local development uses the upstream image
# directly (see .env's CLAMAV_HOST comment).
#
# The upstream image already ships a signature database and runs freshclam to keep it current
# (outbound HTTPS through the private subnets' NAT). Overrides, applied by rewriting the upstream
# clamd.conf rather than appending, because clamd rejects a directive defined twice:
#   - TCPSocket/TCPAddr: task-local only, as above.
#   - StreamMaxLength: 26M, just above the workers' CLAMAV_MAX_FILE_BYTES default (25 MiB), so clamd
#     never truncates a stream the worker considers in bounds.
#   - ConcurrentDatabaseReload no: a signature update reloads in place instead of holding a second
#     copy of the ~1.5 GB database while the new one loads, which would double peak memory.
#
# The task definition's healthCheck runs studafy-clamdcheck.sh (end of this file);
# the workers container waits on it (dependsOn HEALTHY) so no scan is attempted before the
# signatures are loaded.

ARG CLAMAV_VERSION=1.4

FROM clamav/clamav:${CLAMAV_VERSION}

RUN set -eu; \
    conf=/etc/clamav/clamd.conf; \
    sed -i -E '/^#?[[:space:]]*(TCPSocket|TCPAddr|StreamMaxLength|ConcurrentDatabaseReload)[[:space:]]/d' "$conf"; \
    printf '%s\n' \
      'TCPSocket 3310' \
      'TCPAddr 127.0.0.1' \
      'StreamMaxLength 26M' \
      'ConcurrentDatabaseReload no' >> "$conf"

# Health check for the task definition. The upstream clamdcheck.sh dials `localhost`, which resolves
# to ::1 first in this image while clamd binds 127.0.0.1 only (above), so it never sees PONG and
# the workers container — which waits on this check — would never start. Same PING/PONG probe,
# pinned to the address clamd actually listens on.
RUN printf '%s\n' \
      '#!/bin/sh' \
      '[ "$(echo PING | nc 127.0.0.1 3310)" = "PONG" ] || { echo "clamd not answering on 127.0.0.1:3310"; exit 1; }' \
      'echo "clamd is up"' > /usr/local/bin/studafy-clamdcheck.sh \
    && chmod 755 /usr/local/bin/studafy-clamdcheck.sh
