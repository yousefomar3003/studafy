#!/usr/bin/env bash
# Entrypoint of the all-in-one ERPNext image (infra/docker/erpnext-fly.Dockerfile). Runs as root,
# prepares the /data volume, then execs supervisord (supervisord.conf), which runs every process.
# Safe to re-run: every step checks what is already there.
#
# /data (the fly volume erpnext_data; a named volume locally):
#   mysql/        MariaDB data directory, created on first boot with MARIADB_ROOT_PASSWORD
#   redis-queue/  the queue Redis's append-only file
#   sites/        the bench's sites directory: one directory per school's site, plus the global
#                 common_site_config.json. Bind-mounted at /home/frappe/frappe-bench/sites.
#
# Why a bind mount and not a symlink: bench and the agent run commands such as
# `../env/bin/python` from sites/, and the kernel resolves `..` from the physical directory. Behind
# a symlink that is /data, not the bench. A bind mount keeps sites/ physically inside the bench.
# Mounting needs root with CAP_SYS_ADMIN: fly machines have it; locally db/compose.yml adds it.
#
# With arguments, it prepares /data the same way and then runs them instead of supervisord.
#
# It never runs `bench migrate` or changes a site's schema: upgrades run
# `bench --site all migrate` by hand (docs/runbooks/erpnext-fly.md), and the deploy rollback relies
# on a boot leaving every site as it was.
set -Eeuo pipefail

BENCH=/home/frappe/frappe-bench
SKELETON=/usr/local/share/erpnext-fly/sites
MARIADB_CNF=/etc/erpnext-fly/mariadb.cnf
DATA=/data
MYSQL_DATA="$DATA/mysql"
REDIS_QUEUE_DATA="$DATA/redis-queue"
SITES="$DATA/sites"

log() { echo "entrypoint: $*" >&2; }
die() {
  log "$*"
  exit 1
}

# Fixes ownership only where it is wrong, so a large sites tree costs a walk, not a rewrite. Also
# repairs files an operator created as root (fly ssh console runs as root).
own_tree() {
  find "$2" -xdev \( \! -user "$1" -o \! -group "$1" \) -exec chown -h "$1:$1" {} +
}

[[ "$(id -u)" == 0 ]] || die "must run as root (it prepares /data, then supervisord drops privileges)"

mkdir -p "$DATA" /run/mysqld
chown mysql:mysql /run/mysqld
# Left over if the container restarted with its filesystem (docker restart; fly starts from a fresh
# root filesystem). wait-for-services.sh takes the socket as "MariaDB is up", so it must not
# outlive the mariadbd that made it. Nothing is running yet at this point.
rm -f /run/mysqld/mysqld.sock /run/mysqld/mysqld.pid /run/mysqld/init.sock /run/mysqld/init.pid

# ---- MariaDB: first boot only ---------------------------------------------------------------------
# Initialised in a scratch directory and renamed into place only once the root password is set, so
# a boot interrupted half way leaves no data directory and the next boot simply starts over.
init_mariadb() {
  : "${MARIADB_ROOT_PASSWORD:?must be set on the first boot (it becomes the MariaDB root password)}"
  local scratch="$DATA/mysql.init" sock=/run/mysqld/init.sock pid i
  log "first boot: initialising the MariaDB data directory"
  rm -rf "$scratch"
  mkdir -p "$scratch"
  chown mysql:mysql "$scratch"
  mariadb-install-db --defaults-file="$MARIADB_CNF" --datadir="$scratch" --user=mysql \
    --skip-test-db --auth-root-authentication-method=socket >/dev/null

  # A private instance: no TCP, its own socket, so nothing else can connect meanwhile.
  mariadbd --defaults-file="$MARIADB_CNF" --datadir="$scratch" --user=mysql --skip-networking \
    --socket="$sock" --pid-file=/run/mysqld/init.pid &
  pid=$!
  for ((i = 0; i < 60; i++)); do
    mariadb-admin --socket="$sock" ping >/dev/null 2>&1 && break
    kill -0 "$pid" 2>/dev/null || die "MariaDB exited during first-boot initialisation"
    sleep 1
  done
  ((i < 60)) || die "MariaDB did not start within 60 s during first-boot initialisation"

  # root@localhost keeps unix_socket too, so root inside the machine (this script, an operator on
  # fly ssh) connects without the password. The password goes over stdin, never on a command line.
  # Escaped for a single-quoted SQL string: \ -> \\, ' -> ''.
  local bs=\\ q=\' pw
  pw="${MARIADB_ROOT_PASSWORD//"$bs"/"$bs$bs"}"
  pw="${pw//"$q"/"$q$q"}"
  mariadb --socket="$sock" <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED VIA mysql_native_password USING PASSWORD('${pw}') OR unix_socket;
FLUSH PRIVILEGES;
SQL
  mariadb-admin --socket="$sock" shutdown
  wait "$pid"
  mv "$scratch" "$MYSQL_DATA"
  log "first boot: MariaDB initialised"
}

if [[ ! -d "$MYSQL_DATA/mysql" ]]; then
  if [[ -d "$MYSQL_DATA" ]] && [[ -n "$(ls -A "$MYSQL_DATA")" ]]; then
    die "$MYSQL_DATA exists but holds no MariaDB system database; refusing to touch it"
  fi
  rmdir "$MYSQL_DATA" 2>/dev/null || true
  init_mariadb
fi
own_tree mysql "$MYSQL_DATA"
chmod 0750 "$MYSQL_DATA"

mkdir -p "$REDIS_QUEUE_DATA"
own_tree redis "$REDIS_QUEUE_DATA"

# ---- bench sites: every boot ----------------------------------------------------------------------
mkdir -p "$SITES"

# The installed apps and their built assets come from the image, so an upgraded image is picked up
# on the next boot: apps.txt/apps.json are copied over, and assets/ links to the image's copy.
install -m 0644 "$SKELETON/apps.txt" "$SKELETON/apps.json" "$SITES/"
if [[ "$(readlink "$SITES/assets" || true)" != "$SKELETON/assets" ]]; then
  rm -rf "$SITES/assets"
  ln -s "$SKELETON/assets" "$SITES/assets"
fi

# Global bench config. Merged, so keys an operator added (maintenance_mode, ...) survive. No
# default site: gunicorn picks each request's site from its Host header, and bench commands must
# name --site.
python3 - "$SITES/common_site_config.json" <<'PY'
import json
import os
import sys

path = sys.argv[1]
conf = {}
if os.path.exists(path):
    with open(path) as f:
        text = f.read().strip()
    conf = json.loads(text) if text else {}
conf.update(
    {
        "db_host": "127.0.0.1",
        "db_port": 3306,
        "redis_cache": "redis://127.0.0.1:13000",
        "redis_queue": "redis://127.0.0.1:11000",
        "redis_socketio": "redis://127.0.0.1:11000",
    }
)
conf.pop("default_site", None)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(conf, f, indent=1, sort_keys=True)
    f.write("\n")
os.replace(tmp, path)
PY
rm -f "$SITES/currentsite.txt"
own_tree frappe "$SITES"

# Mount /data/sites at the bench's sites/ unless this boot already did.
if [[ "$(stat -c %d:%i "$SITES")" != "$(stat -c %d:%i "$BENCH/sites")" ]]; then
  mount --bind "$SITES" "$BENCH/sites" ||
    die "cannot bind-mount $SITES at $BENCH/sites (needs root with CAP_SYS_ADMIN; locally see db/compose.yml)"
fi

if (($# > 0)); then
  exec "$@"
fi
exec /usr/bin/supervisord -c /etc/erpnext-fly/supervisord.conf
