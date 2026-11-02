#!/usr/bin/env bash
# Regenerates the Dart API client (ST-062) from apps/api/openapi.json (ST-060) into
# lib/src/core/api/generated/. Run via `bun run client:generate` from apps/mobile, or
# `bun run mobile:client:generate` from the repo root. See lib/src/core/api/README.md.
#
# Output is gitignored (see ../../.gitignore and docs/runbooks/merge-conflicts-generated-files.md)
# — regenerated on demand and in CI, never committed, so two branches touching routes never
# conflict on it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

rm -rf lib/src/core/api/generated

dart run swagger_parser generate

# Two deterministic post-generation repairs for known swagger_parser 1.44.1 codegen bugs — see the
# doc comment at the top of each script for the exact bug and why a schema-level workaround isn't
# the fix. Both are no-ops against already-correct output, so this is safe to run unconditionally.
dart run scripts/fix_sealed_union_imports.dart
dart run scripts/fix_boolean_enum_literals.dart

dart run build_runner build --delete-conflicting-outputs

dart format lib/src/core/api/generated >/dev/null
