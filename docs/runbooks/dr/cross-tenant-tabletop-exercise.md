# Cross-tenant tabletop exercise (SEV1)

Facilitated paper drill for
[`docs/runbooks/cross-tenant-incident.md`](../cross-tenant-incident.md) — the suspected
cross-tenant incident (SEV1) runbook. Exercises the runbook's decision points, containment order,
and recovery trade-offs without touching a live database, so the tabletop can run today even though
the runbook's mechanism (`FORCE ROW LEVEL SECURITY`, `app.school_id` GUC, the `test:security`
probe) has no applied environment to exercise against yet.

**Status — read before treating anything here as "done":** this file is the exercise _document_.
Running the exercise and writing up the conduction is a separate act, recorded in a drill report
(`st-266-game-day-drill-report.md` is the precedent this repo already has for that format). Until
that drill report exists and links here, the acceptance criterion "SEV1 cross-tenant runbook
tabletop-tested" is **not met**, and should not be reported as met.

## Why a tabletop and not a live drill

Same honesty constraint the ST-266 drill report already led with: `infra/terraform` has never been
applied to a real AWS account, there is no prod compute tier, and the only `test:security`
executions so far are the CI job's and the local test suite against the local Docker Postgres. A
live "trigger a cross-tenant leakage in staging" drill is impossible until a staging environment
exists. What a tabletop _can_ do today, and what the ST-266 drill could not: rehearse the human
decision chain — severity declaration, evidence-before-action ordering, least-destructive
containment, root-cause triage, and the recovery trade-off — which are all wrong-without-costly
to get wrong and which no additional AWS account would change.

## Roles

From `docs/runbooks/dr/README.md`'s Ownership table, as the runbook's own Severity section resolves
them:

| Role                    | Holder at exercise start                 | In a real incident                                       |
| ----------------------- | ---------------------------------------- | -------------------------------------------------------- |
| Incident commander (IC) | Designated by facilitator                | Whoever opens the `dr-incident cross-tenant` issue first |
| Data-plane operator     | Designated by facilitator                | DBA / infra-ticket assignee                              |
| Comms lead              | Designated by facilitator (may equal IC) | IC unless scope warrants split                           |
| Facilitator / evaluator | Not an IC or operator                    | n/a — observes, times, injects                           |

Participants act; the facilitator never answers decision-point questions, only reads the injection
and the clock. Command drafting is expected; **no SQL or `bun` command on this sheet is executed
during the exercise.**

## How to run

1. Pick one injection (below). Every injection is a separate run; do not combine.
2. Start the clock at the first detection statement. Expected pace: 60-75 minutes per run.
3. Feed detection exactly as written — no extra hints. If participants ask for `pg_policies` output
   or audit rows, the facilitator pretends to run the command and gives the predetermined evidence
   that injection defines.
4. Enforce the runbook's stages: declaration/notification → evidence → containment → triage → fix →
   verify → recovery → close-out. Participants may not skip the evidence stage to "save time".
5. Debrief using the checklist at the bottom; file every gap as a `dr-gap` issue (DR README's gap
   workflow) and update `cross-tenant-incident.md`'s Known gaps if the exercise surfaces a new one.

## Injections

Five injections, one per tabletop run. Each maps to one of the runbook's five failure shapes, plus
a comms-only variant that tests severity discipline on a _suspected_ (not confirmed) report.

| #   | Failure shape (runbook §"How RLS works")                         | Detection statement (read verbatim)                                                                                                                                             | Predetermined evidence the facilitator produces                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Shape 1 — RLS policy dropped                                     | "School A's staff say their roster page shows School B's class list. No deploy happened in the last hour. Slowness is not reported."                                            | A user report; `pg_policies` shows `app.class_groups` with no `class_groups_tenant_policy` row while `rowsecurity=false` in `pg_tables`; CI's `auditRlsCoverage` was green on `main` this morning                                  |
| 2   | Shape 2 — GUC wrong / stale session leak                         | "Two teachers in School B report seeing School A's students in their gradebook for about five minutes, then it self-corrected after they reloaded."                             | `pg_stat_activity` shows two pooled connections where `current_setting('app.school_id', true)` holds School A's UUID while their `query` touches School B rows; `server_reset_query_always = 1` is present in the PgBouncer config |
| 3   | Shape 3 — wrong `schoolId` passed in code                        | "Student Carer in School A has an attendance record in School B's slice per the audit log. No user report yet — found via audit query."                                         | `app.audit_logs` row in School B's slice whose `actor_id` belongs to School A; RLS coverage audit passes (policies present and forced)                                                                                             |
| 4   | Shape 4 — trigger blocks `school_id` mutation (positive control) | "A script attempted to move a Student row from School A to School B and got an error. The request is being reported as a cross-tenant breach."                                  | Error `SQLSTATE 42501` in app logs; RLS coverage audit passes; this is a _working_ control — expected outcome is "not an incident", per the runbook's shape 4 note                                                                 |
| 5   | Comms-only — suspected but unconfirmed                           | (No data yet.) "A school admin says they 'sometimes' see another school's name in a dropdown for a second, but can't reproduce it. They won't be able to follow up for a week." | Nothing — severity discipline test: does the IC declare SEV1, and how are comms paced while unconfirmed?                                                                                                                           |

## Decision points this exercise specifically rehearses

The runbook's three decision points, in order, with the evaluation the facilitator scores against:

1. **Confirmed vs suspected.** For injections 1-3 the correct reading is _confirmed_ (evidence
   exists); for injection 5 the correct reading is _suspected but still SEV1 until ruled out_. A
   participant who needs "more data" before declaring on injection 5 is wrong here — the runbook
   mandates treatment as SEV1.
2. **Read vs write.** Injection 2 (self-corrected read of another school's class list) is a read;
   injection 3 (an attendance row landed in the wrong slice) is a write. The write demands the
   containment step and the step-6 recovery decision; the read does not.
3. **Root-cause shape.** Expected from evidence, not from guesswork: injection 1 → policy gone
   (evidence: `pg_policies`/`pg_tables`), injection 2 → code path / pool leak (evidence:
   `current_setting` on live connections), injection 3 → wrong GUC value (evidence: audit log).
   A participant who answers "policy gone" for all three gets triaged as having skipped evidence.

## Expected actions by runbook step

The facilitator scores the run against the runbook's own procedure; correct behavior per step:

| Runbook step            | Correct behavior to observe                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Preserve evidence    | No reboot, no PgBouncer restart, no `ALTER` before the three read-only queries run. Evidence gathered _before_ any containment statement                                                        |
| 2. Contain              | Write incident → least-destructive first (`REVOKE INSERT, UPDATE, DELETE ... FROM studafy_admin`), read-only escrow only as escalation; read-only incident → targeted revoke, not a blanket one |
| 3. Identify             | Triage driven by the evidence the facilitator provided, in the runbook's order                                                                                                                  |
| 4. Fix                  | Fix matches the shape (re-`CREATE POLICY` for shape 1, deploy-rollback for shape 2/3, PgBouncer config review for leaks) — and _not_ "rewrite all policies" for every shape                     |
| 5. Verify               | `test:security` re-run against the prod URL before any re-deploy, and treated as a hard gate                                                                                                    |
| 6. Recover (write only) | Options stated with their true cost (PITR rolls back every school; targeted deletion trusts audit completeness) and the chosen path recorded in the issue — no invented RPO/RTO                 |
| 7. Close loop           | DR README resolution template posted; follow-up tickets named; a decision on expanding the probe for the shapes the probe missed                                                                |

## Pass / fail criteria

Pass requires all of:

- IC declared SEV1 and posted the DR README initial notification within the 15-minute window
  (injections 1-3, 5 — injection 4 expects the _opposite_ verdict, correctly identifying shape 4 as
  not an incident).
- Evidence stage completed before any write-path containment.
- Containment chosen was the least destructive option that matches the read/write reading.
- Root cause was determined from evidence, and the fix matched the shape.
- Verification (`test:security`) ran and passed before re-deploy was attempted.
- No fabricated operational numbers (RPO/RTO) appear anywhere in the exercise record.
- Comms templates delivered on the DR README schedule.

Fail on any of:

- Any containment or destructive action before the evidence stage (reboot, PgBouncer restart,
  `ALTER DATABASE SET default_transaction_read_only = ON` as the first move).
- Re-deploy attempted without a passing verification run.
- Injection 4 treated as an incident.
- Injection 5 downgraded below SEV1 because unconfirmed.

## Debrief checklist

Run after each injection; the report captures each item's verdict, not just "passed".

1. Which statements and commands were actually executed vs spoken-only, and were every spoken
   command's details verified against source (module `.tf`/`.sh`, `db/policies/rls-coverage`,
   `apps/api/tests/security/cross-tenant.test.ts`) rather than remembered?
2. Timing: when did declaration, first evidence, first containment, and verify each happen, and
   which of the 15-minute / 30-minute comms SLOs were hit or missed?
3. Which decision points were argued about previously, i.e. ambiguous in the runbook, and should
   the runbook's Decision points section be tightened?
4. Which of the five failure shapes got exercised (all five should over the year) and which known
   gaps of `cross-tenant-incident.md` did the run confirm vs soften?
5. What gaps surfaced that are **not** in the runbook's Known gaps yet — file each as a `dr-gap`
   issue, and add the ones that change the runbook's procedure to its Known gaps.
6. Did the comms lead reuse the DR README templates unchanged, or invent new phrasing (which the
   repo does not want — templates exist so content, not form, varies)?

## Cadence

- Minimum: annually, and after any change to `db/migrations/000006_create_rls_helper.sql`,
  `db/migrations/000012_create_attendance_tables_with_partitioning.sql`, `db/policies/*`,
  `modules/pgbouncer`, or `apps/api/tests/security/cross-tenant.test.ts` — the five things that
  define the failure shapes.
- Add injection 6 (runtime-detection-dependent) the day a real-time cross-tenant probe exists, per
  the runbook's Known gaps.
- Record each conduction as a drill report in `docs/runbooks/dr/` following
  `st-266-game-day-drill-report.md`'s structure (result up front, what was verified vs not, gap
  backlog), and link it here.
