# Pilot school onboarding (launch #1)

Onboard 2–3 pilot schools on `prod`: white-glove import, a working feedback loop, and measured
success criteria (staff activation ≥80%, daily attendance usage, zero SEV incidents) over a
4-week window. Ends in a go/no-go verdict in [`pilot-completion-report.md`](pilot-completion-report.md).

**This runbook is a sequence, not a status.** Nothing here is "done" because a school was selected.
Every step has a defined output; a step does not close until its output is verified. Where a step
fails, there is an explicit path (exit to incident flow, or exit to the provisioning checklist's
troubleshooting) instead of a suggestion to "keep going".

## Gate — read before starting

- [ ] **Prod is verified live.** Ran `docs/runbooks/environment-matrix.md`'s _apply-to-verified_
      runbook end to end. If this is not checked, **stop** — see `launch/README.md`'s status note.
- [ ] Dependency gates met (DR runbooks, security pass) — see `launch/README.md`'s table.
- [ ] Cohort list approved (2–3 schools, section 1). No names in this repo — resolve at kickoff.
- [ ] Roles resolved to people: Pilot lead, one School liaison per school, Importer, Feedback
      triage (see `launch/README.md`'s ownership table).

Exit condition: every checkbox above is checked with evidence, not intent.

## 1. Cohort selection — 2–3 schools

Pick schools that will actually exercise the product daily, not the ones that say yes fastest.
Selection criteria, all must hold:

- **Champion with release authority** — a named individual at the school (the School liaison)
  who can approve staff onboarding and unblock issues in-hours. A pilot without this is a
  support pin, not a pilot.
- **Staff roster on hand** — name + email per staff member to import, in a file with an
  audited count. >0 staff is non-negotiable; the roster is the activation-rate denominator.
- **Fits the current trial model in week 1** — school must fit the 50-student trial cap during
  week 1 (`app.subscriptions.student_cap` / `trial_expires_at`, provisioned per
  `tenant-provisioning-checklist.md`); converting to a paid plan is a week-2+ decision, not an
  import prerequisite.
- **ERPNext plane confirmed for the school** — country/currency exist in the school's Frappe
  Company bootstrap; the site `{school-slug}.erpnext.studafy.com` provisions cleanly.
- **Class structure fits the academic model** — the school's classes/terms map to the existing
  `academic_period`/`class` structure without civil-engineering workarounds.

**Outputs:** the cohort list (school slugs from `app.schools.slug`, one-line rationale each),
one School liaison named per school, one kickoff issue opened (label `pilot-cohort`) containing
all three.

## 2. White-glove import (per school)

Run for each pilot school, in order. Steps 2.1–2.3 should be a quiet, repairable half-day; if any
step turns into heroics, stop and escalate before proceeding — a 3-day import is a signal the
school was the wrong pilot, not a reason to import harder.

### 2.1 Create the school and provision

Reuse the real self-service pipeline — do not hand-insert rows. This is deliberate: the pilot is
also drilling the production onboarding path.

```
POST /api/schools/register            (public, captcha-protected)
    → school created, status='registered', admin user created (ORG_ADMIN, invited)
    → returns verification_token + invitation_token (once only)

GET /api/schools/verify-email/{token} (public)
    → email verified, status='active', trial begins
    → async provisioning starts (fire-and-forget)
```

**Verify provisioning completed** before importing anyone:

```sql
SELECT s.slug, s.status, s.provisioning_status,
       sub.status AS subscription_status, sub.student_cap,
       ess.site_name, ess.status AS erpnext_status
FROM app.schools s
LEFT JOIN app.subscriptions sub             ON sub.school_id = s.id
LEFT JOIN app.erpnext_site_configs ess      ON ess.school_id = s.id
WHERE s.slug = :school_slug;
```

Expected: `status='active'`, `provisioning_status='completed'`, trial subscription present,
`erpnext_status` healthy. Any `failed`/`in_progress` state → follow
`tenant-provisioning-checklist.md`'s Troubleshooting section; do not import people into a school
whose billing/ERP plane is not clean.

### 2.2 Import staff

Two legal moves, one importer, audited counts before and after:

1. **Bulk invite via the imports module** — the staff roster file (section 1) as a bulk staff
   import, which creates `app.users` (`status='invited'`) and `app.invitations` per staff
   member, staff roles only (`ORG_ADMIN`, `INSTRUCTOR`, `TEACHING_ASSISTANT`, `SUPPORT_AGENT`,
   `FINANCE`). Roster CSV count ↔ rows created must match before the import is declared done.
2. **Any hand-added account goes through the normal invitation flow** — same activation path as
   self-service. No direct `INSERT` into `app.users`/`app.user_roles` with a fabricated status.

Correct the admin account from `2.1` if the register flow named a different admin than the
liaison wants — via the normal invite/activation path, never by UPDATE on `app.users.status`.

**Verify the denominator (invited staff) before sending invites:** this is the activation-ratio
denominator for the whole 4 weeks, so it must be audited now:

```sql
SELECT i.role, COUNT(*) AS invited
FROM app.invitations i
WHERE i.school_id = :school_id
  AND i.revoked_at IS NULL
  AND i.created_at >= :import_start
GROUP BY i.role
ORDER BY i.role;
```

Compare per-role totals to the roster file. Mismatch = stop; missing invites → re-run import for
the diff, over-count → revoke the excess via the UI (never a bare `DELETE`).

### 2.3 Champion walkthrough and sign-off

- Champion logs in through the activation flow (real OIDC, real `POST /auth/activate`).
- Install walk through: the setup wizard (`/onboarding/setup`), first attendance session created
  and marked, one correction exercised.
- **Sign-off closes 2.3**: liaison confirms the school can record attendance unassisted.

**Outputs of section 2, per school:** provisioning verification output, invited-staff counts list,
champion sign-off note — all appended to the school's entry in the kickoff issue.

## 3. Success criteria — measured, not asserted

Three numbers per school, a fourth per cohort. Metric names are canonical
(`launch/README.md` — a metric means the same thing in the runbook, the SQL below, and the report).

### 3.1 `staff_activation_rate` — target ≥80% per school by end of week 4

Activated = the invitation was consumed (`consumed_at IS NOT NULL`) **and** the user is
`status='active'`. Denominator = the invited-staff count from 2.2. Numerator and denominator in
the same query, so they cannot drift apart:

```sql
WITH invited AS (
  SELECT i.id, u_normal.id IS NOT NULL AND u_normal.status = 'active' AS activated
  FROM app.invitations i
  LEFT JOIN app.users u_normal
         ON u_normal.school_id = i.school_id
        AND u_normal.normalized_email = i.normalized_email
  WHERE i.school_id = :school_id
    AND i.revoked_at IS NULL
    AND i.created_at >= :import_start
    AND i.role <> 'STUDENT'
)
SELECT COUNT(*) FILTER (WHERE activated) AS activated,
       COUNT(*)                          AS invited,
       CASE WHEN COUNT(*) > 0
            THEN round(100.0 * COUNT(*) FILTER (WHERE activated) / COUNT(*), 1)
            ELSE 0 END                   AS staff_activation_rate
FROM invited;
```

Read as: one number per school, recorded at the same UTC time on each Monday of weeks 2–4 and
early in week 5. Recompute from raw data each time (no storing running values — the denominator
is stable but only-now-safe).

### 3.2 `daily_attendance_usage` — target: every pilot school records attendance on ≥5 school days/week

A day counts if the school wrote at least one non-draft `attendance_sessions` with at least one
`attendance_records` row that day. The attendance tables are monthly-range-partitioned on
`created_at`, so the report window is bounded by partitions that exist (they are created by the
partition-upkeep worker; every month in the pilot window must already have one):

```sql
SELECT date_trunc('day', created_at)::date AS day,
       COUNT(*)                            AS sessions_written
FROM app.attendance_sessions
WHERE school_id = :school_id
  AND status <> 'draft'
  AND created_at >= :window_start
  AND created_at <  :window_end
GROUP BY 1
ORDER BY 1;
```

(One row per record-writing session is enough for a usage signal; precise record counts live in
`app.attendance_records`, which is why corrections slices are cheap to query for drill-downs.)

### 3.3 `sev_incident_count` — target: zero per cohort

"SEV incident" = any of, per `docs/runbooks/alert-catalog.md` and
`docs/runbooks/incident-comms-templates.md`: a paged/acknowledged alert, a `dr-incident` or
`deploy-failure` GitHub issue, or **any cross-tenant or security-adjacent finding** affecting a
pilot school — including a positive from the `.github/workflows` `cross-tenant-security` /
`secret-scan` / `secret-scan-history` CI jobs, or a `tests/security` regression on a PR.

Not a guess based on "nothing bad happened": the check is a search of the incident/alert issue
labels + the CI job history for (window ∩ pilot-school-affecting). Record 0 only when that search
returns nothing.

## 4. Feedback loop (weeks 1–4)

Structured so feedback lands in a backlog, not in a chat window.

1. **Mailbox**: GitHub issues labeled `pilot-feedback`, filed by anyone (school side posts via the
   liaison with the school slug in the title). One issue per problem — no megathreads.
2. **Triage**: weekly, by the Feedback-triage role. Each issue gets a disposition, in-repo:
   - `backlog` — accepted, prioritized on the roadmap board;
   - `sev` — crossed into 3.3 territory; open a `dr-incident`/incident per section 3.3;
   - `wontfix` — closed with a written reason (silence is not a disposition);
   - `training` — a usage/teaching gap, not a defect; routed to the liaison.
3. **Outcome check**: at the end of each week, at least one triage cycle ran, every `pilot-feedback`
   issue has a disposition, and `sev` dispositions are cross-posted to section 3.3's count.
4. **Escalation path**: a school stops using attendance → liaison gets 1 business day to say why,
   then it is a decision by the Pilot lead (see section 5 verdict) — never left to drift.

## 5. The 4-week cadence

| Week    | M                              | Tue–Thu                              | Fri                                                                   | Exit condition                                                                       |
| ------- | ------------------------------ | ------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1       | Cohort + import (section 2)    | Champion walkthroughs, install fixes | First triage; metrics baseline (activation sitting at invites-so-far) | Every school: provisioning verified, import audited, champion signed off             |
| 2       | Measure 3.1/3.2                | Daily-usage support                  | Triage #2                                                             | ≥25% of staff activated, attendance seen on ≥3 school days, no cross-tenant findings |
| 3       | Measure 3.1/3.2                | Daily-usage support                  | Triage #3                                                             | ≥50% of staff activated, attendance on ≥5 school days/week, no cross-tenant findings |
| 4       | Measure 3.1/3.2                | Final fixes, collect open feedback   | Triage #4; **freeze metrics**                                         | All `pilot-feedback` issues dispositioned; final measurements taken                  |
| 5 (Mon) | Freeze re-check + write report | —                                    | —                                                                     | [`pilot-completion-report.md`](pilot-completion-report.md) filed                     |

**Metrics freeze** (start of week 5) is the moment the numbers stop moving. Anything that changes
after freeze is a follow-up ticket, not an adjustment to the report.

## Verdict rules

The completion report ends with one of, per cohort:

- **Go** — both targets met (≥80% activation, ≥5 days/week attendance uptake), zero SEV, feedback
  dispositioned. Proceed to next cohort of schools / general onboarding.
- **Pause** — neither target met but no SEV: fix the honest blocker (product gap, training gap,
  cohort mismatch) before the next cohort; the report names it.
- **Stop** — a SEV occurred, or both targets missed with no identified remediable cause: no further
  pilots until the blocker is resolved; the report names it and the follow-up tickets exist.

## Incident exit

Any SEV during the window: leave this runbook, run
`docs/runbooks/dr/` or `docs/runbooks/deploy-rollback.md` as the failure demands, use
`docs/runbooks/incident-comms-templates.md` for comms, and record the incident in section 3.3's
`sev_incident_count` and the report. The 4-week clock does not pause for incidents — the report
counts them.

## Known gaps

- Cohort size is capped at 3 by design (one importer, one liaison-per-school ratio that doesn't
  scale). Scaling beyond 3 is a separate decision after the Go verdict.
- No dashboard panel exists for these metrics; the queries in section 3 are the source of truth
  until a pilot-specific Grafana panel is warranted (the metrics catalog doesn't grow for a
  4-week cohort).
- The staff-role set in 2.2 is an explicit list; if `app.user_role` (migration 000007 plus later
  additions) gains roles, verify the list against `pg_enum` in prod before import.
