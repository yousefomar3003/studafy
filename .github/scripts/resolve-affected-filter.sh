#!/usr/bin/env bash
# Prints a turbo `--filter=...[<ref>]` argument on stdout, selecting only packages changed since
# the resolved base commit (see resolve-base-sha.sh) plus their dependents. Prints nothing when no
# usable base commit exists, so the caller falls back to running every package.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base="$(bash "${script_dir}/resolve-base-sha.sh")"

if [ -n "$base" ]; then
  echo "--filter=...[${base}]"
fi
