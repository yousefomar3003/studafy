# Launch runbooks

Step-level runbooks for taking Studafy from "self-service registration works" to "a small
number of real schools depend on it daily". The pilot is the proving ground; everything here is
written to be disposable after it — the process, the queries, and the report are means to a
go/no-go decision, not permanent product state.

Source of the mechanisms every runbook here operates:
[`docs/runbooks/tenant-provisioning-checklist.md`](../tenant-provisioning-checklist.md) (ST-089)
and the DR library in [`docs/runbooks/dr/`](../dr/) (ST-266). Those say _what_ is provisioned and
_what breaks_; this directory says _what a human does, in order,_ to onboard 2–3 pilot schools on
prod, measure the acceptance criteria, and decide whether to keep going.

## Status — read this before treating anything here as "ready to roll pilots in prod"

**Prod is not live.** `docs/runbooks/environment-matrix.md`'s honesty note says it plainly: every
value there reflects what this repo's Terraform/deploy code is written to produce; none of it has
been applied against a real AWS account. "Apply-ready" is `terraform fmt`, `terraform validate`,
and an offline `plan` — not a running environment. This directory is written for exactly that
gap: the onboarding procedure, the feedback loop, and the success-criteria queries are complete
and exec-ready today, but **pilots must not be onboarded until a `prod` environment exists and
passes the apply-to-verified runbook** in `environment-matrix.md`.

Consequences, stated so nobody mistakes preparation for execution:

- The **mechanics** below (registration → provisioning → invitation → activation, imports,
  monitoring queries) are read from API/service source and migration SQL and are accurate to what
  that code does on a real deployment.
- The **operational sequencing** (cohort selection, white-glove import, feedback triage, weekly
  cadence) is this ticket's addition — executable in sequence, not yet exercised against a live
  prod.
- The **report template** has no numbers in it. No pilot metric gets a value until it is measured
  against a live environment.

## Dependency gates

| Dependency                                                                    | Status   | Evidence                                                                                                         |
| ----------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| DR runbooks authored and first drill executed (this task's stated dependency) | **Met**  | `docs/runbooks/dr/` — six scenarios + `st-266-game-day-drill-report.md`                                          |
| Pre-launch security pass clean                                                | **Met**  | `docs/runbooks/security/st-249-security-pass.md` — zero critical/high open; cross-tenant suite green (462 tests) |
| Cross-tenant isolation regression gate in CI                                  | Met      | `tests/security/route-guard-wiring.test.ts` runs on every PR via `cross-tenant-security` job                     |
| **Prod environment applied to real AWS and verified**                         | **Open** | No live account in this repo's history; run `environment-matrix.md`'s _apply-to-verified_ runbook first          |

A pilot school is not "live" until the prod gate is closed. Until then, treat everything in
[`pilot-school-onboarding.md`](pilot-school-onboarding.md) as rehearsal-ready, hold the
completion report, and keep the cohort list internal.

## Canonical naming

- **Runbook filenames** are a kebab-case noun phrase naming _what is being done_ (`pilot-school-onboarding.md`, `pilot-completion-report.md`). The manual is one noun; the report is one noun — two files, two jobs, no overlap.
- **Environment tokens**: `dev | staging | prod`, exactly as `infra/terraform/README.md` and `environment-matrix.md` define them. Never "production", "prd", or "live".
- **School identity**: a pilot school is identified by its `app.schools.slug` (canonical) plus `app.schools.id`. Never invent shorthand for a real school.
- **Metric names**: `staff_activation_rate`, `daily_attendance_usage`, `sev_incident_count` — fixed across the onboarding runbook, the report template, and any SQL, so a number means the same thing in all three places.

## The runbooks

| #   | Runbook                                                  | Purpose                                                                                                       |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | [pilot-school-onboarding.md](pilot-school-onboarding.md) | Select 2–3 schools, white-glove import them on prod, run the feedback loop for 4 weeks, measure the criteria  |
| 2   | [pilot-completion-report.md](pilot-completion-report.md) | The deliverable: one doc per pilot cohort with measured metrics, feedback disposition, and a go/no-go verdict |

## Ownership — roles, not people

Same convention as `docs/runbooks/dr/README.md`: no names in this repo — resolve the role to a
person at kickoff.

| Role            | Responsibility                                                                                        | Interim proxy                                        |
| --------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Pilot lead (IC) | Owns the cohort list, the import schedule, and the go/no-go verdict; single point of truth for status | Whoever opens the pilot kickoff issue first          |
| School liaison  | One per pilot school; the champion-side contact, owns the staff roster and the activation walkthrough | Named from each school's team, not from this repo    |
| Importer        | Runs the white-glove import procedure and its reconciliation queries for a school                     | The person holding prod DB/api access for the import |
| Feedback triage | Triages `pilot-feedback` issues each week into backlog or SEV                                         | Rotating; whoever owns the backlog board that week   |

## Comms

Feedback and incidents reuse the rich patterns already written:
[`docs/runbooks/incident-comms-templates.md`](../incident-comms-templates.md) for any incident
touching a pilot school, and the `dr-incident` / `deploy-failure` GitHub-issue proxy convention
for anything that cannot page a human. A recurring `pilot-feedback` label on GitHub issues is the
feedback loop's mailbox — full detail in the onboarding runbook's
[section 4 (Feedback loop)](pilot-school-onboarding.md#4-feedback-loop-weeks-14).
