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

## SQL safety

Every query in `apps/api` goes through [postgres.js](https://github.com/porsager/postgres). Its
tagged template sends each `${}` as a **bound parameter** — the value never becomes SQL text, so
it cannot change the statement. That is the only way request data may reach the database.

```ts
// ✅ Tagged template: `search` is a bound parameter ($1), never SQL text.
const rows = await tx`SELECT id FROM app.users WHERE email ILIKE ${`%${search}%`}`;

// ✅ Optional clauses are tagged fragments, composed into the outer template.
const statusFilter = status ? tx` AND u.status = ${status}` : tx``;

// ✅ .unsafe() with static text; values go in the params array.
await tx.unsafe("SELECT set_config('app.school_id', $1, true)", [schoolId]);

// ✅ .unsafe() with a module-level constant (the column-list idiom).
const USER_COLUMNS = `u.id, u.email, u.display_name`;
await tx`SELECT ${tx.unsafe(USER_COLUMNS)} FROM app.users u`;

// ❌ Interpolated or concatenated .unsafe() text — lint error.
await tx.unsafe(`SELECT id FROM app.users WHERE email = '${email}'`);
await tx.unsafe("SELECT id FROM app.users WHERE id = " + id);
```

`SET` / `SET LOCAL` cannot take a parameter. To set a runtime value transaction-locally, use
`` tx`SELECT set_config('<name>', ${value}, true)` `` instead.

### Enforcement

- **Lint** — `studafy/no-interpolated-sql`
  ([`packages/config/rules/no-interpolated-sql.js`](packages/config/rules/no-interpolated-sql.js))
  is an error for `apps/api/src/**` (test files excluded). The first argument to any `.unsafe()`
  call must be static: a string literal, a template whose every `${}` is static, a `+` of static
  parts, or a `const` bound to one of those. Anything known only at runtime — a parameter, a
  `let`, a call result, a property read — is reported. CI's lint step fails on it.
- **Seeded violation** — [`apps/api/tests/security/interpolated-sql-lint.test.ts`](apps/api/tests/security/interpolated-sql-lint.test.ts)
  lints a known violation through the real root config. If the rule is removed, downgraded to a
  warning, or stops covering `apps/api/src`, that test fails CI.
- **Injection probes** — [`apps/api/tests/security/sql-injection.test.ts`](apps/api/tests/security/sql-injection.test.ts)
  sends boolean, error-based, UNION, stacked, and time-based payloads to every free-text search
  and enum filter endpoint (`bun run test:security`, needs `TEST_DATABASE_URL`). **A new endpoint
  that accepts free text must be added to its `FREE_TEXT_ENDPOINTS` list.**

The rule is syntactic: it cannot read TypeScript types or follow imports. When a dynamic
`.unsafe()` argument is genuinely safe (for example a `"COMMIT" | "ROLLBACK"` union), disable the
rule on that line with a reason, so the exception is visible in review:

```ts
// eslint-disable-next-line studafy/no-interpolated-sql -- `command` is typed "COMMIT" | "ROLLBACK"
await reserved.unsafe(command);
```

Identifiers (table or column names chosen at runtime) cannot be bound as parameters. Pick them from
a hard-coded allowlist, never from request input, and pass them through `tx(identifier)`, which
quotes them.

### Code review checklist

For any change that touches SQL:

- [ ] Request data reaches SQL only through a tagged template `${}` or the `.unsafe()` params array.
- [ ] Every new `eslint-disable … studafy/no-interpolated-sql` states why the value cannot come
      from a caller, and the reviewer agrees.
- [ ] Runtime identifiers (tables, columns, sort keys) come from a hard-coded allowlist.
- [ ] A new free-text search or filter parameter is added to `sql-injection.test.ts`.
