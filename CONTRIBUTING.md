# Contributing

## Getting started

```
bun install
```

`bun install` also installs the Git hooks (via the `prepare` script running
`lefthook install`) — no extra setup step is required.

## Commit messages

This repo enforces [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description
```

`scope` is optional. Allowed `type` values:

| Type       | Use for                                                       |
| ---------- | ------------------------------------------------------------- |
| `feat`     | a new feature                                                 |
| `fix`      | a bug fix                                                     |
| `docs`     | documentation only changes                                    |
| `style`    | formatting, whitespace (no code behavior change)              |
| `refactor` | code change that neither fixes a bug nor adds a feature       |
| `perf`     | a performance improvement                                     |
| `test`     | adding or correcting tests                                    |
| `build`    | changes to the build system or dependencies                   |
| `ci`       | changes to CI configuration                                   |
| `chore`    | maintenance work not covered by the above                     |
| `revert`   | reverts a previous commit                                     |
| `infra`    | infrastructure/tooling changes (monorepo config, hooks, etc.) |

Examples:

```
feat(api): add authentication middleware
fix(web): resolve login redirect
docs: update contributing guide
chore: upgrade dependencies
refactor(shared): simplify schema exports
test(api): add validation tests
infra(monorepo): optimize turbo cache
```

### How the hooks work

Hooks are run by [Lefthook](https://github.com/evilmartians/lefthook), configured in
[`lefthook.yml`](lefthook.yml):

- **pre-commit** — runs on staged files only:
  - `lint-staged` ([`lint-staged.config.js`](lint-staged.config.js)) formats staged files with
    Prettier and runs `eslint --fix`, re-staging the fixed files.
  - if any staged files are TypeScript, `turbo run check-types --filter="[HEAD]"` type-checks
    only the packages affected by your change (not the whole repo).
- **commit-msg** — runs `commitlint` ([`commitlint.config.js`](commitlint.config.js)) against
  your commit message and rejects it if it doesn't follow the format above.

### Bypassing hooks in an emergency

`git commit --no-verify` skips all hooks. Use this only for genuine emergencies (e.g. a
production hotfix) — a commit that bypasses hooks still needs to pass lint/typecheck/commit
message review before merge.

### Troubleshooting

- **Hooks aren't running at all** — run `bunx lefthook install` to (re)install them.
- **Commit message rejected** — check the `type(scope): description` format against the table
  above; common mistakes are an unsupported `type`, uppercase letters, or a missing colon/space.
- **Pre-commit is slow** — the `check-types` step scales with how many packages your change
  affects; a large or root-level change will type-check more packages than a small leaf-package
  change. `lint-staged` only processes files you've staged, so isolate unrelated changes into
  separate commits if a run feels slow.
