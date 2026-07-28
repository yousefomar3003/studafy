# Merge conflicts in generated files

## Problem (historical)

Before `infra(monorepo): stop tracking generated files to eliminate merge conflicts`, three files
were committed and changed on every branch that touched routes, schemas, or the database:

| File                                         | Changes when                     | Merge conflict reason                     |
| -------------------------------------------- | -------------------------------- | ----------------------------------------- |
| `apps/api/openapi.json`                      | routes or Zod schemas change     | Large JSON — Git can't merge structurally |
| `packages/api-client/src/generated-types.ts` | `openapi.json` changes (derived) | Incompatible line-level diffs             |

Two branches independently regenerating these files made "can't auto merge" all but inevitable.

## Current approach

`apps/api/openapi.json` and `packages/api-client/src/generated-types.ts` are **no longer tracked
in git** — both are listed in `.gitignore`. They are regenerated on demand:

- Locally: `bun run openapi:generate` then `bun run client:generate` (also runs automatically as
  a `generate` dependency of `check-types`, `test`, and `build` via `turbo.json`).
- In CI: the same generation step runs before the pipeline; `scripts/check-drift.sh` /
  `packages/api-client/scripts/check-drift.ts` now just verify generation succeeds and produces
  internally consistent output — they no longer diff against a committed copy.

Because neither file is committed, merging any branch into `dev` (or `dev` into a branch) no
longer produces conflicts on them — there's nothing to conflict. This applies to any branch cut
**after** the change above landed.

## Branches cut before the change

A branch created before generated files stopped being tracked may still have its own committed
copy of `apps/api/openapi.json` and/or `packages/api-client/src/generated-types.ts`. Merging
`dev` into it produces a `modify/delete` conflict (dev deleted the path, the old branch still
modifies it). To fix:

```bash
# 1. Update your branch with the latest dev
git checkout feature-branch
git merge dev
# → conflict: modify/delete on the generated file(s)

# 2. Drop the file(s) from tracking — dev's .gitignore now covers them
git rm --cached apps/api/openapi.json packages/api-client/src/generated-types.ts 2>/dev/null

# 3. Resolve any remaining source-code conflicts, then regenerate to confirm it still works
bun run openapi:generate
bun run client:generate

# 4. Commit and merge to dev as normal
git add -A
git commit
git checkout dev
git merge feature-branch
```

If the branch is old enough that this is the _only_ change left on it (i.e. its actual code
change already landed on `dev` some other way), it's usually simpler to close it than to drag it
through a multi-hundred-commit merge — check first with `git rev-list --left-right --count
origin/dev...origin/feature-branch`.

## Migration file conflicts

`db/migrations/*.sql` files are still committed (they must be, as an audit trail of applied
schema changes) and can still collide when two branches both add e.g. `000054_*.sql`:

- **Never edit an already-applied migration.** Once `000054_foo.sql` has run on any shared
  database (`dev`, `staging`, `production`), its content is frozen. A corrective forward
  migration is the only safe path.
- **If two branches both add the same migration number and neither is applied anywhere yet:**
  renumber one to the next available version. The runner validates sequential order but
  tolerates gaps.
- **After resolving conflicts, always run** `bun run db:migrate:validate` to confirm all applied
  migration versions, names, and checksums match the files on disk.
