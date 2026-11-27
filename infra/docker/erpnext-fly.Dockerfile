# All-in-one ERPNext for fly.io (studafy-core-erpnext, infra/fly/erpnext.toml): MariaDB, two Redis,
# Frappe gunicorn, one RQ worker, the scheduler and the site agent (infra/erpnext/agent) on one
# 2 GB machine, under supervisord. One Frappe site per school; gunicorn picks it from the Host
# header. See docs/plans/erpnext-fly.md for why it is one machine.
#
# Build from the repo root, like every Dockerfile here (infra/docker/README.md):
#   docker build -f infra/docker/erpnext-fly.Dockerfile -t studafy/erpnext-fly .
# Locally: `bun run erpnext-fly:up` (db/compose.yml, profile "erpnext-fly", port 8090).
#
# The bench layers are the same as erpnext.Dockerfile's (same pinned base, same Education app),
# so both images share their layers. The process layout, configs and entrypoint live in
# infra/erpnext/fly/.

# Pinned by the same digest as erpnext.Dockerfile, for the same reason (see there). Dependabot
# proposes new upstream digests; keep both files on the same one.
FROM frappe/erpnext:version-15@sha256:de8e0068467b4ea5a9d1b0a7c07e37b1ed8d2ea8d2f9d02c316bfd4d5a80f5f3

USER frappe
WORKDIR /home/frappe/frappe-bench

# Same as erpnext.Dockerfile (see there for the branch choice and why the caches go in this RUN).
RUN bench get-app education --branch version-15.2 https://github.com/frappe/education && \
    bench build --app education && \
    rm -rf /home/frappe/.cache /home/frappe/.npm apps/education/.git

USER root

# mariadb-server, redis-server and supervisor are Debian bookworm's packages (MariaDB 10.11 LTS,
# Redis 7.0); the base image already ships the matching MariaDB client. rclone (nightly backups to
# R2) is upstream's .deb, pinned by version and checksum: bookworm's rclone is 1.60 (2022). The
# package installs leave datadirs behind (/var/lib/mysql); the entrypoint creates the real ones on
# the /data volume, so they and the apt lists go in this same RUN.
ARG TARGETARCH
ARG RCLONE_VERSION=1.76.0
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) rclone_sha256=9db7ee9b725bce7cdd195b9183449a4c6fb93cad3e6578e70b87c0bc7f6062e9 ;; \
      arm64) rclone_sha256=c486d404ecbc4bb3d54052a0efaf9e652cf0d2c645e4523f7a2aefa112fe029c ;; \
      *) echo "unsupported TARGETARCH '${TARGETARCH}'" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends mariadb-server redis-server supervisor; \
    curl -fsSLo /tmp/rclone.deb \
      "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${TARGETARCH}.deb"; \
    echo "${rclone_sha256}  /tmp/rclone.deb" | sha256sum -c -; \
    dpkg -i /tmp/rclone.deb; \
    rm -rf /tmp/rclone.deb /var/lib/apt/lists/* /var/lib/mysql/* /var/log/mysql/*; \
    mariadbd --version; redis-server --version; supervisord --version; rclone version | head -1

# The image's sites/ skeleton (apps.txt, apps.json, built assets), kept outside sites/ so the
# entrypoint can refresh the volume's copy from it on every boot (an upgraded image brings new
# apps.txt and asset bundles). Root-owned: the bench only reads it.
RUN mkdir -p /usr/local/share/erpnext-fly && \
    cp -a /home/frappe/frappe-bench/sites /usr/local/share/erpnext-fly/sites && \
    rm -f /usr/local/share/erpnext-fly/sites/common_site_config.json && \
    chown -R root:root /usr/local/share/erpnext-fly/sites

# Provisioning scripts and the site agent, on PYTHONPATH (not bench apps: no doctypes, no
# migrations). PYTHONUNBUFFERED so the agent's output reaches the log stream as it happens.
COPY --chown=frappe:frappe infra/erpnext/seed/ /home/frappe/frappe-bench/erpnext_seed/
COPY --chown=frappe:frappe infra/erpnext/agent/ /home/frappe/frappe-bench/erpnext_agent/
ENV PYTHONPATH=/home/frappe/frappe-bench \
    PYTHONUNBUFFERED=1

COPY infra/erpnext/fly/ /etc/erpnext-fly/
RUN chmod 0644 /etc/erpnext-fly/* && chmod 0755 /etc/erpnext-fly/*.sh

# The entrypoint runs as root (it prepares /data and mounts sites/), then supervisord starts each
# program as its own user: mysql, redis, frappe.
#
# The base image declares VOLUMEs on sites/ and logs/. fly ignores them; local Docker mounts
# anonymous volumes there, and the entrypoint bind-mounts /data/sites over sites/ either way.
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=120s --retries=3 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/8000'
ENTRYPOINT ["/etc/erpnext-fly/entrypoint.sh"]
CMD []
