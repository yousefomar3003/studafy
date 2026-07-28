# Merge conflicts in generated files

## Problem

After running the standard checks (`openapi:generate`, `client:generate`, `db:migrate`) on a
feature branch, merging back to `dev` fails with "can't auto merge". Resolving the conflicts
manually often corrupts the generated files and breaks `db:migrate`.

## Root cause

Three committed files change on every branch that touches routes, schemas, or the database:

| File                                         | Changes when                     | Merge conflict reason                     |
| -------------------------------------------- | -------------------------------- | ----------------------------------------- |
| `apps/api/openapi.json`                      | routes or Zod schemas change     | Large JSON — Git can't merge structurally |
| `packages/api-client/src/generated-types.ts` | `openapi.json` changes (derived) | Incompatible line-level diffs             |
| `db/migrations/*.sql`                        | a new migration is added         | Two branches both add `000054_*.sql`      |

These files are intentionally committed so contract changes appear in PR diffs (see script
comments in `apps/api/scripts/generate-openapi.ts`), but this design means **merge conflicts are
inevitable** when two branches independently regenerate them.

## Prevention workflow (recommended)

Merge `dev` into your feature branch first, then regenerate. This way the regenerated files are
produced from the combined code and match what `dev` expects.

```bash
# 1. Update your branch with the latest dev
git checkout feature-branch
git merge dev

# 2. Resolve any source-code conflicts (routes, schemas, etc.)

# 3. Regenerate the committed artifacts from the merged code
bun run openapi:generate
bun run client:generate

# 4. If you added a migration, check the numbering is still sequential
#    (another branch may have added a migration with the same number)
ls db/migrations/ | sort -n | tail -5

# 5. Commit the regenerated files
git add apps/api/openapi.json packages/api-client/src/generated-types.ts db/migrations/
git commit -m "chore: regenerate after merge"

# 6. Now merge to dev — generated files will be identical, no conflicts
git checkout dev
git merge feature-branch
```

## Recovery workflow (already in conflict)

If you're already stuck in a merge conflict:

```bash
# 1. Accept both sides for generated files, then regenerate
git checkout --ours apps/api/openapi.json
git checkout --ours packages/api-client/src/generated-types.ts
bun run openapi:generate
bun run client:generate

# 2. For migration file conflicts — one branch added 000054_foo.sql,
#    another added 000054_bar.sql. Keep both with new sequential numbers:
#    - Keep 000054_foo.sql
#    - Rename 000054_bar.sql → 000055_bar.sql
#    Update the renamed file's internal references if any.
#    IMPORTANT: Only do this if NEITHER migration has been applied to
#    any shared environment yet.

# 3. Verify the result
bun run db:migrate:validate
bun run format:check
bun run typecheck

# 4. Stage and commit
git add .
git commit -m "chore: resolve generated file conflicts and regenerate"
```

## Migration-specific rules

- **Never edit an already-applied migration.** Once `000054_foo.sql` has run on any shared
  database (`dev`, `staging`, `production`), its content is frozen. A corrective forward
  migration is the only safe path.
- **If two branches both add the same migration number and neither is applied anywhere yet:**
  renumber one to the next available version. The runner validates sequential order but
  tolerates gaps.
- **After resolving conflicts, always run** `bun run db:migrate:validate` to confirm all
  applied migration versions, names, and checksums match the files on disk.
