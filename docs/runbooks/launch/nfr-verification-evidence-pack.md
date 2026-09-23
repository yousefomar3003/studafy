# NFR verification and evidence pack (ST-295)

Compiles this repo's actual NFR-relevant evidence — load-test results, chaos/game-day drill
outcomes, SLO history, security evidence — into one pack for the GA go/no-go review
([`ga-launch-checklist.md`](ga-launch-checklist.md), item 1). Read
[`docs/testing/load-test-scenarios.md`](../../testing/load-test-scenarios.md) and
[`security/st-249-security-pass.md`](../security/st-249-security-pass.md) first; this pack indexes
and verdicts their evidence, it does not repeat it.

**This pack reports what exists. It does not fabricate a staging run, a chaos drill, or an NFR
document that isn't in this repo.** Where the ticket's own premise doesn't match the repo, that
mismatch is recorded as the first finding, not silently patched over.

## The premise vs. what this repo actually has

The ticket asks for verification of "all 15 NFRs (SAD §5)." Neither half of that exists here:

- **There is no SAD with numbered sections.** The five files matching `SAD_*.md`
  (`docs/architecture/SAD_13_session_model.md`, `SAD_16_entitlement_flow.md`,
  `SAD_21_notification_dispatch_flow.md`, `SAD_28_logging_conventions.md`,
  `SAD_30_backup_policy.md`) are numbered by the ticket that wrote them, not by document section —
  there is no `§5`, and no file enumerates a list of 15 NFRs. `grep -rn "§5\|section 5" docs`
  returns one unrelated hit (a pilot verdict cross-reference).
- **Exactly five distinct NFR IDs are referenced anywhere in this repo**
  (`grep -rniE "NFR-[0-9]+"` across `docs/`, `infra/`, `apps/`): NFR-01, NFR-02, NFR-03, NFR-05,
  NFR-11. Not fifteen. Of those five, only **one** — NFR-05 — has a formal document
  (`docs/security/NFR-05_cross_tenant_isolation.md`). NFR-01, NFR-02, and NFR-03 each say, in their
  own source comments, that no such document exists anywhere in this repo
  (`infra/load-tests/config/thresholds.js`, `infra/terraform/modules/monitoring/README.md`).
  NFR-11 had no `docs/` file at all — it existed only as a comment in three test files. (Closed
  while compiling this pack: [`docs/security/NFR-11_rag_groundedness.md`](../../security/NFR-11_rag_groundedness.md)
  now exists — see [Part A](#part-a--the-five-nfr-ids-that-actually-exist) and the
  [gap register](#gap-register)'s "closed while compiling this pack" note. The finding above is
  left as originally made because it's what a fresh audit of this repo would still find for
  NFR-01/02/03, and because the fix is worth recording as a fix, not silently backdated.)
- **The IDs aren't even used consistently.** `load-test-scenarios.md` reads NFR-02 as
  "error-rate/availability budget"; the monitoring module separately treats NFR-03 as "the
  availability SLO." Two different authors picked two different numbers for overlapping ground —
  itself a small piece of evidence that no canonical numbered list was ever agreed on.

Verifying "all 15" would mean inventing ten NFRs and their targets from nothing. This pack instead
does the honest version of the acceptance criteria: **(A)** verdict every NFR ID that actually
exists in this repo, **(B)** compile the real quality-attribute evidence this repo has under other
names (security, DR/backup, accessibility, locale, tenant-isolation, query performance, load-test
infrastructure) since that's the substance a "GA evidence pack" is actually for, **(C)** gap-list
what's missing with an owner and a remediation target, per the acceptance criteria's own wording.

## Part A — the five NFR IDs that actually exist

| ID     | Name (as used in-repo)               | Formal doc?                                                                                                                      | Evidence                                                                                                                                                                                                                         | Verdict                   |
| ------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| NFR-01 | API latency budget                   | **No** — proposed default only                                                                                                   | k6 suite exists (`infra/load-tests/`) but has run only against a throwaway mock HTTP server, never a real Postgres/API stack, never staging. No real latency number exists.                                                      | **Gap**                   |
| NFR-02 | Error-rate / availability budget     | **No** — proposed default only                                                                                                   | Same suite, same "never run for real" state.                                                                                                                                                                                     | **Gap**                   |
| NFR-03 | Availability SLO (99.9% proposed)    | **No** — proposed default only                                                                                                   | Dashboard and synthetic-probe mechanism is built (`infra/terraform/modules/monitoring/synthetics.tf`, `<prefix>-availability-slo` CloudWatch dashboard) but has never been applied to a real AWS account.                        | **Gap**                   |
| NFR-05 | Cross-tenant isolation               | **Yes** — `docs/security/NFR-05_cross_tenant_isolation.md`                                                                       | Real, continuous: the ST-051 probe runs as the `CI / cross-tenant-security` required check on every PR (773-line suite, `apps/api/tests/security/cross-tenant.test.ts`).                                                         | **Pass, with one caveat** |
| NFR-11 | RAG groundedness / retrieval quality | **Yes** — [`docs/security/NFR-11_rag_groundedness.md`](../../security/NFR-11_rag_groundedness.md), authored as part of this pack | Real, deterministic, offline: `bun test ./tests/ai-eval` gates groundedness ≥0.95, citation accuracy ≥0.90, refusal correctness ≥0.95 against a 15-case golden set. Last run 2026-09-23: 1.00 / 0.91 / 1.00 — all three cleared. | **Pass**                  |

**NFR-05 caveat:** the probe's continuous evidence is against CI's synthetic two-school fixture.
`ga-launch-checklist.md` item 1 already flags that GA sign-off needs this reconfirmed against the
pilot cohort's real prod data — that hasn't happened, because the pilot itself hasn't run
(`pilot-completion-report.md` has no cohort filled in). Recorded here as an **accepted-risk carry
forward from CI to the pilot**, not a new gap: the mechanism is proven, the pilot-data
reconfirmation is a dependency, not an NFR-05 defect.

**NFR-11 caveat, and a correction to this pack's own earlier draft:** an earlier pass over this
pack flagged `test:ai-eval` as not wired into any CI workflow, based on grep-ing
`.github/workflows/*.yml` for the literal string `ai-eval` and finding no explicit step. That
check was insufficient — actually running the suite showed `apps/api`'s `test` script (`bun test`,
no path argument) recursively discovers and runs `tests/ai-eval/harness.test.ts` by default, so
`CI / quality`'s "Unit tests with coverage" step already exercises and gates this suite on every
PR that puts `@studafy/api` in the affected-package filter. **There is no CI gap.** Full detail
and the corrected finding are in the new formal doc's own "CI status" section. What remains a real
caveat: it measures groundedness against a fixed 15-case golden set, not live traffic — no
production/staging measurement exists (same "no environment has ever taken real traffic" gap as
NFR-01/02/03).

## Part B — the real evidence this repo has, under other names

The acceptance criteria's actual concern — load results, chaos drill outcomes, SLO history,
security evidence — maps onto real work in this repo even where it isn't tagged `NFR-xx`.

| Quality attribute                 | Source                                                                                                      | Evidence                                                                                                                                                                                                                                                                                                  | Verdict                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Internal security pass            | [`security/st-249-security-pass.md`](../security/st-249-security-pass.md)                                   | 16 findings against a real Postgres + real app, zero critical/high open at exit; 462-test cross-tenant suite green; full-history secret scan clean (0 real secrets / 541 commits).                                                                                                                        | **Pass**                                                   |
| External penetration test         | [`security/st-250-external-pentest-commissioning.md`](../security/st-250-external-pentest-commissioning.md) | Scope, ROE, WAF allowlist, and seeded two-tenant staging are ready. Vendor not contracted, engagement not run, report not received, remediation/retest not started.                                                                                                                                       | **Gap**                                                    |
| Backup RPO/RTO target             | [`SAD_30_backup_policy.md`](../../architecture/SAD_30_backup_policy.md)                                     | RPO ≤ 5 min / RTO ≤ 4 h is documented and the underlying mechanism (RDS PITR) is capable of it per source review.                                                                                                                                                                                         | Target documented, **not measured**                        |
| Chaos / game-day drill            | [`dr/st-266-game-day-drill-report.md`](../dr/st-266-game-day-drill-report.md)                               | Six DR runbooks authored, every restore script read and cross-referenced, `terraform validate` passes for `module.backup`. **The drill did not run against real infrastructure and no real RPO/RTO number was measured** — no AWS account has ever been applied to. Ten gaps filed (`dr-gap`, #278–#287). | **Gap** — see note below                                   |
| Load-test results                 | [`testing/load-test-scenarios.md`](../../testing/load-test-scenarios.md)                                    | Three k6 scenarios (attendance peak, results-day read storm, AI ask concurrency) are mechanically verified against a mock HTTP server; the run→archive→regression-compare pipeline is proven. Never run against real Postgres/API, never against staging.                                                 | **Gap**                                                    |
| Query performance                 | [`database/query-budget.md`](../../database/query-budget.md)                                                | Twenty hot query shapes checked with `EXPLAIN`/`enable_seqscan=off` against seeded fixtures — all twenty index-served, committed as a running CI-adjacent test (`packages/db/tests/query-plan-budget.test.ts`). No `pg_stat_statements` staging sample exists (staging has never run).                    | **Pass**, proves index existence only, not production cost |
| Tenant-isolation structural audit | [`testing/rls-policy-coverage.md`](../../testing/rls-policy-coverage.md)                                    | ST-050 catalog audit runs in the `CI / database-migrations` job on every PR: RLS coverage, composite FK, tenant-ownership trigger, index-plan checks.                                                                                                                                                     | **Pass**                                                   |
| Accessibility (mobile)            | [`testing/mobile-accessibility-audit.md`](../../testing/mobile-accessibility-audit.md)                      | Static + `meetsGuideline` audit; 8 findings fixed (4 High, 3 Medium, 1 Low), regression coverage added. 6 findings ticketed, not fixed — 1 High (PDF materials have no screen-reader text layer), rest Medium/Low.                                                                                        | **Pass, with ticketed follow-ups**                         |
| Accessibility (web)               | `CI / web-accessibility` (ST-211)                                                                           | axe budget + keyboard-only walkthrough, runs on every PR.                                                                                                                                                                                                                                                 | **Pass**                                                   |
| Timezone / locale correctness     | [`testing/timezone-test-catalog.md`](../../testing/timezone-test-catalog.md)                                | DST + RTL matrix, every deadline/digest-label assertion pinned to a fixed instant, Postgres as the timezone oracle.                                                                                                                                                                                       | **Pass**                                                   |
| Critical user journeys (E2E)      | [`testing/critical-journeys-e2e.md`](../../testing/critical-journeys-e2e.md)                                | Seven journeys, real Postgres/Redis/API/workers/ERPNext sandbox; Anthropic and Stripe faked at documented seams. Runs nightly + manual pre-release trigger.                                                                                                                                               | **Pass**                                                   |
| Staging environment itself        | [`environment-matrix.md`](../environment-matrix.md)                                                         | `infra/terraform/bootstrap` applied 2026-09-11 (state buckets, DNS zone, OIDC, per-env IAM roles). Network/data/app-tier modules for every environment — including staging — remain unapplied.                                                                                                            | **Gap** — blocks every "against staging" item above        |

**On "chaos drill outcomes" and "SLO history" specifically**, since the ticket names both:

- No chaos-engineering exercise (fault injection against a running system) exists in this repo in
  any form. The nearest analog is the DR game-day drill above, which is a recovery-procedure drill,
  not chaos engineering, and which itself did not run against real infrastructure.
- There is no SLO history to compile. `slo.yml`'s multiwindow burn-rate alerts
  (`ApiAvailabilityFastBurn`/`SlowBurn`, `ApiLatencyFastBurn`/`SlowBurn`) and the NFR-03 synthetics
  dashboard are real, committed mechanisms — but no environment has ever taken real traffic, so
  there is zero real burn-rate or uptime history anywhere to report. "SLO history: none exists yet"
  is the accurate entry, not a placeholder number.

## Gap register

Every row below is a real, currently-open gap, not a formality. Remediation targets are proposed
planning dates tied to the named blocking dependency — confirm with the item's owner at the actual
GA go/no-go review before treating a date as committed.

| #   | Gap                                                                  | Blocks                                                        | Owner (role)               | Remediation target                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No real NFR-01/NFR-02 target document exists                         | Meaningful latency/error-rate pass-fail                       | Perf/platform owner        | Author the document before the next load-test run is scheduled; no date until an owner is assigned — currently unowned. The missing input is a real target number from whoever filed ST-248, not a doc file — writing a doc alone cannot close this.                                                                                                                                                            |
| 2   | No NFR-03 document; 99.9% is a conventional default                  | Meaningful availability sign-off                              | SRE/on-call owner          | Same as #1 — author alongside NFR-01/02, same "needs a real number, not just a file" caveat                                                                                                                                                                                                                                                                                                                     |
| 3   | Load-test suite never run against real Postgres/API                  | Any real NFR-01/02 measurement                                | Perf owner                 | Re-attempted while compiling this pack: `docker compose -f db/compose.yml up -d --wait` fails here with "failed to connect to the docker API ... The system cannot find the file specified" — no Docker daemon reachable in this authoring environment, independently confirming `load-test-scenarios.md`'s own note. **No date** — needs a machine with a running Docker daemon, not more time on this ticket. |
| 4   | Staging/prod network, data, and app-tier Terraform modules unapplied | Every "against staging" row in Part A/B                       | Infra owner                | Tracked by `ga-launch-checklist.md`'s own dependency gate ("Prod environment applied") — no independent date; inherits that item's timeline                                                                                                                                                                                                                                                                     |
| 5   | DR game-day drill never run against real infrastructure              | Measured RPO/RTO                                              | Infra/DR owner             | Re-run the ST-266 drill once gap #4 closes — **no independent date**, blocked on #4                                                                                                                                                                                                                                                                                                                             |
| 6   | External pentest not contracted                                      | Item 2 of GA checklist; independent validation of ST-249      | Security/procurement owner | Procurement decision outside engineering's control — no engineering-set date; escalate to whoever owns vendor budget                                                                                                                                                                                                                                                                                            |
| 7   | No chaos-engineering exercise of any kind exists                     | Confidence in failure-mode behavior beyond DR restore         | Infra/SRE owner            | Not previously scoped by any ticket in this repo — recommend filing as a new ticket once gap #4 closes; **no target date, unscoped work**                                                                                                                                                                                                                                                                       |
| 8   | No real SLO/burn-rate history                                        | Confirming `slo.yml`'s thresholds are sane under real traffic | SRE owner                  | Automatic once gap #4 closes and the environment takes real traffic for at least one burn-rate window (multi-day) — **no independent date**                                                                                                                                                                                                                                                                     |
| 9   | NFR-05 not reconfirmed against pilot cohort real prod data           | Full GA sign-off on NFR-05                                    | Security owner             | Blocked on the pilot itself running — inherits `pilot-school-onboarding.md`'s own timeline, not independently datable                                                                                                                                                                                                                                                                                           |

**Closed while compiling this pack** — resolved with real, verifiable work rather than carried
into the numbered register above:

- _NFR-11 had no formal document._ Closed —
  [`docs/security/NFR-11_rag_groundedness.md`](../../security/NFR-11_rag_groundedness.md) authored
  from the harness's real, already-enforced thresholds (0.95/0.90/0.95) and a real run recorded
  (2026-09-23: groundedness 1.00, citation accuracy 0.91, refusal correctness 1.00 — all cleared).
- _`test:ai-eval` believed unwired from CI._ This was never actually a gap — it was a mistaken
  finding in this pack's own first draft, based on grep-ing workflow YAML for the literal string
  `ai-eval` and finding no explicit step. Actually running `bun test` in `apps/api` showed it
  recursively discovers and runs `tests/ai-eval/harness.test.ts` by default, so `CI / quality`
  already exercises and gates this suite whenever `@studafy/api` is in a PR's affected-package
  filter. No fix was needed; the fix was verifying instead of trusting one grep pattern.

Gaps 4, 5, 6, 8, 9 above cannot carry a real engineering-committed date because each is blocked on
a dependency this repo's code cannot resolve (an applied AWS account, a procurement decision, a
completed pilot) — giving them a fabricated date would be the same mistake
`ga-launch-checklist.md` and `st-266-game-day-drill-report.md` already refused to make. Gaps 1, 2,
3 were re-attempted directly, not just re-described, while compiling this pack, and each has a
concrete, verified reason engineering time alone can't close it: 1/2 need a real number from
outside this codebase; 3 needs a Docker daemon this environment doesn't have.

## Accepted-risk sign-off — items with no further remediation planned

| Item                                                             | Accepted risk                                                   | Rationale                                                             | Accepted by (role) | Date |
| ---------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------ | ---- |
| `react-router(-dom)` moderate CVEs (ST-249 finding #12)          | Residual advisory, mitigated at app layer via open-redirect fix | No 6.x upstream fix exists; exploit path already closed independently |                    |      |
| `@xmldom/xmldom`, `uuid` moderate CVEs (ST-249 finding #13)      | No reachable call path found                                    | Confirmed during ST-249's dependency audit                            |                    |      |
| devDependency-only high-severity advisories (ST-249 finding #14) | Never ships to production runtime                               | Confirmed dev-only by package graph                                   |                    |      |

Rows above are carried over verbatim from `st-249-security-pass.md`'s own disposition — this pack
does not re-litigate them, only surfaces them as the accepted-risk half of "pass evidence artifact
or accepted-risk sign-off" for the security portion of the pack.

## Reproducing this pack's evidence

```bash
# NFR-05 / tenant isolation (Part A)
POSTGRES_PASSWORD=studafy_local docker compose -f db/compose.yml up -d --wait
TEST_DATABASE_URL='postgresql://studafy_test:studafy_local@127.0.0.1:54329/postgres?sslmode=disable' \
  bun run test:security

# NFR-11 / RAG eval (Part A) — from apps/api
bun run test:ai-eval

# RLS structural audit (Part B)
DATABASE_URL='postgresql://...' DATABASE_SSL_MODE=disable bun run db:test:rls-coverage

# Query plan budget (Part B) — from packages/db
bun test tests/query-plan-budget.test.ts

# Load-test mechanics against a mock target only — NOT staging, see gap #3
infra/load-tests/scripts/run.sh <scenario>
```

No command above reaches staging or prod — none currently exist in an applied state (gap #4).

## Sign-off block — fill in at the actual GA go/no-go review, not before

| Row | NFR / attribute                | Verdict at review | Evidence link | Signed off by (role) | Date |
| --- | ------------------------------ | ----------------- | ------------- | -------------------- | ---- |
| A1  | NFR-01 latency                 |                   |               |                      |      |
| A2  | NFR-02 error-rate/availability |                   |               |                      |      |
| A3  | NFR-03 availability SLO        |                   |               |                      |      |
| A4  | NFR-05 cross-tenant isolation  |                   |               |                      |      |
| A5  | NFR-11 RAG groundedness        |                   |               |                      |      |
| B1  | Security (internal + external) |                   |               |                      |      |
| B2  | DR / backup RPO-RTO            |                   |               |                      |      |
| B3  | Load-test results              |                   |               |                      |      |
| B4  | Chaos drill                    |                   |               |                      |      |
| B5  | SLO history                    |                   |               |                      |      |

A row moves from blank to a verdict only with a linked artifact in this table, same convention as
`ga-launch-checklist.md`'s own sign-off block — never a verbal "looks fine."

## Known gaps (summary)

Nine gaps remain open (see [Gap register](#gap-register)), down from eleven in this pack's first
draft — two closed for real while compiling it: the NFR-11 formal document was authored and run,
and the believed CI-wiring gap turned out, on actually running the suite, not to be a gap at all.

None of the remaining nine carries an engineering-committed date, and that is a deliberate,
verified conclusion rather than an oversight: gaps #1/#2 need a real target number from outside
this codebase (writing a document without that number would just move the "proposed default"
honesty note into a new file); gap #3 was re-attempted directly against this authoring
environment's own Docker installation and failed for the same "no daemon reachable" reason
`load-test-scenarios.md` already documents; gaps #4-#9 are blocked on the same three real-world
dependencies `ga-launch-checklist.md` already names — an applied AWS account, a contracted pentest
vendor, and a completed pilot. This pack does not close GA item 1 — it gives the go/no-go review a
real, linkable artifact to review, with two fewer open items than when this pass started, instead
of a status report that says "in progress."
