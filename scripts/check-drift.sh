#!/usr/bin/env bash
# Regenerates all codegen artifacts locally so a dirty generated file is caught before CI.
# Generated files are gitignored (no merge conflicts), so this validates that generation
# succeeds rather than comparing against a tracked file.
set -uo pipefail

fail=0

echo "==> OpenAPI document"
bun run openapi:generate || fail=1

echo "==> API client"
bun run client:generate || fail=1

echo "==> Permission matrix"
bun run --cwd packages/constants docs:generate
if ! git diff --quiet -- packages/constants/docs/permission-matrix.md; then
  echo "packages/constants/docs/permission-matrix.md does not match packages/constants/src/permissions.ts." >&2
  echo "Run 'bun run --cwd packages/constants docs:generate' and commit the result." >&2
  git --no-pager diff -- packages/constants/docs/permission-matrix.md
  fail=1
fi

exit $fail
