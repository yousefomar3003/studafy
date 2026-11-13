# Pilot completion report (launch #2)

The deliverable of [`pilot-school-onboarding.md`](pilot-school-onboarding.md)'s 4-week window. One
report per cohort, filed by the Pilot lead at the metrics freeze (start of week 5). Numbers are
measured against the live prod environment, not assumed — a section left unfilled means the number
was not measured, and it is reported that way.

**This is a report, not a retrospective.** No narrative bloat; a verdict, the evidence for it, and
the follow-ups. If a section has nothing to say, say "none" — do not invent.

## Header

- Cohort: (2–3 school slugs, `app.schools.slug`)
- Window: (start date) to (end date) — the 4 pilot weeks
- Metrics freeze: (UTC timestamp)
- Pilot lead: (role holder)
- Prod gate: (verified live? when — link to `environment-matrix.md` runbook evidence)

## 1. Per-school success criteria

Measured at freeze. Values come from the section 3 queries in
`pilot-school-onboarding.md`, not from memory.

| School | `staff_activation_rate` (target ≥80%) | `daily_attendance_usage` (target ≥5 days/wk) | `sev_incident_count` (target 0) |
| ------ | ------------------------------------- | -------------------------------------------- | ------------------------------- |
| (slug) | (activated/invited, %)                | (days per week in week 4, or table if below) | 0 / (N — see section 3)         |

Attach one evidence line under the table per school: import rota file path/hash, the exact
invited-staff query output, and the week-4 daily-usage query output. Anyone who wants to re-derive
a number from raw data can; nobody has to take the summary on faith.

## 2. Feedback disposition

Tally of the `pilot-feedback` mailbox, per `pilot-school-onboarding.md` section 4.

| Disposition | Count | Notes (top 3, with issue links)               |
| ----------- | ----- | --------------------------------------------- |
| backlog     |       |                                               |
| sev         |       | (must be zero unless section 3 has incidents) |
| wontfix     |       |                                               |
| training    |       |                                               |

Every filed `pilot-feedback` issue has a disposition at freeze, or the report is late — the two
are the same thing.

## 3. Incidents

- `sev_incident_count`: (0), or for each incident: date, school(s), impact, runbook followed,
  follow-up ticket link. Zero is written only if the section 3.3 search (issue labels + CI job
  history for `cross-tenant-security`/`secret-scan`/`secret-scan-history`) returned nothing.
- Cross-tenant/security findings in the window: (none / list).

## 4. Verdict

One of **Go / Pause / Stop**, per `pilot-school-onboarding.md`'s verdict rules, with the
one-sentence reason it earns that label:

- **Go** — both targets met in every school, zero SEV, feedback dispositioned.
- **Pause** — named blocker, next-cohort precondition, by whom/when it is re-checked.
- **Stop** — SEV occurred or both targets missed with no remediable cause; the stop reasons and
  the follow-ups below are what "stop" returns to.

## 5. Follow-ups

Any open `sev`/`backlog` feedback issues, accept-risk notes, or scaling decisions (e.g. moving
past 3 schools) with ticket links. Empty if the cohort concluded clean.

## Known gaps

(none / honesty note — anything the report could not measure, e.g. a metric that could not be
derived because prod was not yet live when a date passed, stated plainly).
