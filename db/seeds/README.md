# Demo Seed Data

TypeScript seed that builds one fully-populated demo school (`studafy-demo-academy`, "Studafy Demo
Academy") for local development and CI: users in every role with mock OAuth logins, academic
structure, timetable, attendance, assessments, grades, materials with embedded chunks, ERPNext finance
caches, AI data, notifications, school events, and a parent-teacher messaging thread.

The full walkthrough (what is seeded, persona logins, 3NF notes, index health) is
[`docs/database/seeding_guide.md`](../../docs/database/seeding_guide.md). The persona list lives
in one place, [`mock-credentials.ts`](./mock-credentials.ts); this README does not repeat it.

## Prerequisites

- An already-migrated local database (`bun run db:migrate`).
- Local PostgreSQL running, e.g. the disposable test database (`bun run db:up`, which starts
  `test-postgres`/`test-redis` from the root `compose.yml`), with `DATABASE_URL` pointing at it.

## Commands

| Command                       | Entry point        | What it does                                                                                                                                                                     |
| ----------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run db:seed`             | `seed.ts`          | Seeds the local demo tenant, prints a per-table row-count summary, then runs the index health check.                                                                             |
| `bun run db:seed:index-check` | `index-health.ts`  | Re-runs the index health check on its own (read-only, rolled back): every `app` index valid and ready, and representative tenant queries served by an index.                     |
| `bun run db:seed:review`      | `review-tenant.ts` | Provisions the App Store / Play reviewer tenant (`studafy-review-academy`) from the same data modules. Meant for production; see [Reviewer tenant](#reviewer-tenant-production). |

`bun run db:seed` is the only seeder. There are no SQL seed files and no `cli.ts seed` command.
With the full local stack, `docker compose --profile seed run --rm seed` runs the same `seed.ts`
against the compose `postgres` service.

## Behavior

- **All or nothing.** The whole dataset is written in one transaction as `studafy_admin`, with
  `app.school_id` set, under the shared migration advisory lock. A failure anywhere rolls everything
  back.
- **Not re-runnable.** If a school with the tenant's slug already exists, the seed writes nothing,
  prints `Seed skipped: tenant 'studafy-demo-academy' already exists.` and exits non-zero. To reseed,
  recreate or re-migrate a fresh database (`bun run db:down && bun run db:up` for the disposable one).
- **Dated data.** Attendance and audit-log rows land in the monthly partitions the migrations ship; a
  database migrated after those run out needs `bun run db:attendance:partitions` and
  `bun run db:audit:partitions` first.

## Safety guard

[`guard.ts`](./guard.ts) runs before any connection is opened; either layer aborts the run with exit
code 1:

1. **Environment.** `NODE_ENV=production` or `APP_ENV=production` is refused.
2. **Host.** A staging/production-shaped host (`*.rds.amazonaws.com`, `*.rds.*`, or a host segment
   `prod`, `production`, `staging`, `stage`, `preprod`, `pre-prod`) is always refused. Any other host
   that is not local (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `postgres`, `db`, `database`,
   `host.docker.internal`) is refused unless `SEED_ALLOW_NONLOCAL=true` is set for a disposable remote
   CI database.

`db:seed:index-check` uses the same guard.

## Reviewer tenant (production)

`bun run db:seed:review` provisions the reviewer tenant and is meant to run in production. It skips
the host checks above and instead requires `REVIEW_TENANT_SEED_CONFIRM=studafy-review-academy`. If
the tenant already exists it writes nothing and still succeeds, so a pipeline can run it on every
release. Roster: [`review-credentials.ts`](./review-credentials.ts); profiles:
[`tenants.ts`](./tenants.ts). For credentials and provisioning, see
[`docs/runbooks/app-review-access.md`](../../docs/runbooks/app-review-access.md). The local
`db:seed` never creates it.

## Files

| Path                       | Purpose                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `seed.ts`                  | Entry point and the shared `seedTenant` envelope (guard, lock, existence check, one transaction, summary).                |
| `guard.ts`                 | Production safeguards for the demo seed and the reviewer-tenant confirmation.                                             |
| `tenants.ts`               | The two tenant profiles (demo, reviewer).                                                                                 |
| `mock-credentials.ts`      | Demo personas: the single source for seeded users, roles, OAuth identities, and parent links.                             |
| `review-credentials.ts`    | Reviewer-tenant personas.                                                                                                 |
| `support.ts`               | Shared types and deterministic helpers.                                                                                   |
| `data/*.ts`                | One module per domain (school, people, academics, timetable, assessments, materials, finance, ai, engagement, messaging). |
| `index-health.ts`          | Post-seed index validity and usability check.                                                                             |
| `e2e-critical-fixtures.ts` | Extra idempotent fixture for the critical-journeys E2E suite, run by its global setup after `db:seed`.                    |
