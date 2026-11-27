#!/usr/bin/env bash
# Holds a bench program until MariaDB and both Redis (13000 cache, 11000 queue) are up on
# localhost, then execs it. supervisord starts every program at boot without waiting for readiness,
# and MariaDB can take a while (crash recovery after an unclean stop); without this, a program that
# fails fast would use up its start retries and stay down (FATAL).
#
# MariaDB counts as up once its socket file exists: mariadbd creates it only after recovery, right
# before it accepts connections, and the entrypoint removes a stale one at boot. Probing its TCP
# port instead would log an "Aborted connection" warning per probe.
#
# Usage: wait-for-services.sh <command> [args...]
set -euo pipefail

waited=0
wait_until() {
  local what=$1
  shift
  until "$@" 2>/dev/null; do
    if ((waited % 30 == 0)); then
      echo "wait-for-services: waiting for ${what} before starting ${COMMAND}" >&2
    fi
    sleep 1
    waited=$((waited + 1))
  done
}
COMMAND=$1

wait_until "MariaDB" test -S /run/mysqld/mysqld.sock
for port in 13000 11000; do
  wait_until "Redis on 127.0.0.1:${port}" bash -c "exec 3<>/dev/tcp/127.0.0.1/${port}"
done

exec "$@"
