#!/usr/bin/env bash
# Mirrors the drift checks in the CI "quality" job (.github/workflows/ci.yml) so a dirty
# generated file is caught locally instead of in a red CI run. Regenerates each committed
# artifact and fails if it no longer matches what's on disk.
set -uo pipefail

fail=0

echo "==> OpenAPI document"
bun run openapi:generate
if ! git diff --quiet -- apps/api/openapi.json; then
  echo "apps/api/openapi.json does not match the routes it is generated from." >&2
  echo "Run 'bun run openapi:generate' and commit the result." >&2
  git --no-pager diff -- apps/api/openapi.json
  fail=1
fi

echo "==> API client"
if ! bun run client:check-drift; then
  fail=1
fi

echo "==> Permission matrix"
bun run --cwd packages/constants docs:generate
if ! git diff --quiet -- packages/constants/docs/permission-matrix.md; then
  echo "packages/constants/docs/permission-matrix.md does not match packages/constants/src/permissions.ts." >&2
  echo "Run 'bun run --cwd packages/constants docs:generate' and commit the result." >&2
  git --no-pager diff -- packages/constants/docs/permission-matrix.md
  fail=1
fi

exit $fail
