# ClamAV (clamd + freshclam), with this repo's own settings baked in — the malware scanner the
# workers' file-scan queue streams every uploaded object through (apps/workers/src/queues/scan).
#
# Build from the repo root, same convention as every other Dockerfile in this directory
# (infra/docker/README.md's "Why the build context is the repo root"):
#   docker build -f infra/docker/clamav.Dockerfile -t studafy/clamav .
#
# In production it is its own fly app (infra/fly/scanner.toml), reached by the workers over the
# organisation's private network. The image's default binding is 127.0.0.1 only, which means a
# plain `docker run -p 3310` of this image cannot be reached from the host — local development uses
# the upstream image directly (see .env's CLAMAV_HOST comment).
#
# The upstream image already ships a signature database and runs freshclam to keep it current
# (outbound HTTPS). Overrides, applied by rewriting the upstream
# clamd.conf rather than appending, because clamd rejects a directive defined twice:
#   - TCPSocket/TCPAddr: 127.0.0.1 by default. CLAMAV_TCP_ADDRS (space separated) overrides the
#     bind addresses: fly.io builds with "0.0.0.0 ::" and reaches it over the organisation's private
#     network (infra/fly/scanner.toml).
#   - StreamMaxLength 101M, MaxScanSize/MaxFileSize 101M: just above the workers'
#     CLAMAV_MAX_FILE_BYTES default (100 MiB), which matches the largest upload class (material.file,
#     100 MiB). They used to be 25 MiB, so every large material ended `failed` (QA-054).
#   - AlertExceedsMax / AlertEncryptedArchive / AlertEncryptedDoc yes: a file clamd could not scan
#     in full -- an archive member over a limit, an encrypted archive or PDF -- comes back as a
#     detection (Heuristics.Limits.Exceeded / Heuristics.Encrypted.*) instead of OK, so it is
#     quarantined rather than served unscanned (QA-054). A school that must share an encrypted file
#     shares it some other way.
#   - ConcurrentDatabaseReload no: a signature update reloads in place instead of holding a second
#     copy of the ~1.5 GB database while the new one loads, which would double peak memory.
#
# studafy-clamdcheck.sh (end of this file) is the image's health probe: clamd answers PING only
# once the signatures are loaded.

# QA-053: base images are pinned by tag and digest (the multi-arch index), written out in each FROM
# so Dependabot can propose bumps; change both together.

FROM clamav/clamav:1.4@sha256:4cc4350d3fded380caf1799e76c0d1c93f3fa40af99c0cb2862ec0c9b117718a

ARG CLAMAV_TCP_ADDRS="127.0.0.1"

RUN set -eu; \
    conf=/etc/clamav/clamd.conf; \
    sed -i -E '/^#?[[:space:]]*(TCPSocket|TCPAddr|StreamMaxLength|MaxScanSize|MaxFileSize|AlertExceedsMax|AlertEncryptedArchive|AlertEncryptedDoc|ConcurrentDatabaseReload)[[:space:]]/d' "$conf"; \
    printf '%s\n' 'TCPSocket 3310' >> "$conf"; \
    for addr in $CLAMAV_TCP_ADDRS; do printf 'TCPAddr %s\n' "$addr" >> "$conf"; done; \
    printf '%s\n' \
      'StreamMaxLength 101M' \
      'MaxScanSize 101M' \
      'MaxFileSize 101M' \
      'AlertExceedsMax yes' \
      'AlertEncryptedArchive yes' \
      'AlertEncryptedDoc yes' \
      'ConcurrentDatabaseReload no' >> "$conf"

# Health check. The upstream clamdcheck.sh dials `localhost`, which resolves to ::1 first in this
# image while clamd binds 127.0.0.1 by default (above), so it would never see PONG. Same PING/PONG probe,
# pinned to the address clamd actually listens on.
RUN printf '%s\n' \
      '#!/bin/sh' \
      '[ "$(echo PING | nc 127.0.0.1 3310)" = "PONG" ] || { echo "clamd not answering on 127.0.0.1:3310"; exit 1; }' \
      'echo "clamd is up"' > /usr/local/bin/studafy-clamdcheck.sh \
    && chmod 755 /usr/local/bin/studafy-clamdcheck.sh
