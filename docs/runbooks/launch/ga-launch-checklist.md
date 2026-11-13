# GA launch checklist (launch #3)

The gate between a completed pilot cohort and telling every school Studafy is generally
available. One document: the eight items the GA gate is defined by, what "evidenced" means for
each, the current status against this repo's actual state, the go/no-go review procedure, and the
sign-off block that makes this "GA checklist (signed)" once a real review fills it in.

**This is a checklist, not a status report.** Every row below is either **Met** with a path to the
evidence, or **Open** with the concrete blocker — never "in progress" or "on track" as a
substitute for evidence that doesn't exist yet.

## Status — read this before treating anything here as "signed off"

**GA cannot be executed today. Seven of the eight gate items are open, and the dependency this
ticket is gated on has not itself concluded.** This is not a pessimistic estimate — it is what the
rest of this repo already says about itself, collected in one place:

- **The pilot has not run.** [`pilot-school-onboarding.md`](pilot-school-onboarding.md)'s own gate
  blocks starting until its own gates close, and [`pilot-completion-report.md`](pilot-completion-report.md)
  is a template with no numbers filled in. There is no Go verdict to build a GA launch on.
- **Prod is live, on fly.io, not AWS.** The AWS account bootstrapped on 2026-09-11 never got
  past its account-wide plumbing and was retired; production runs on fly.io with Supabase, Redis
  Cloud, R2, Resend, Sentry and Axiom ([`infra/fly/README.md`](../../../infra/fly/README.md)) and
  is deployed by **Production deploy (fly.io)** (`.github/workflows/fly-production-deploy.yml`).
  Several items below were scoped against AWS mechanisms (RDS backups, the S3/CloudFront status
  page, Alertmanager paging) that no longer exist; each says so.

Treat every "Open" row below as exactly that — not a formality left to tidy up before a review,
but a real artifact (a contract, a report, a named roster, a provisioned account) that does not
exist in this repo or its history. Running this checklist today would mean fabricating evidence,
which is worse than leaving the row open.

## Dependency gate

| Dependency                                             | Status   | Evidence                                                                                                                                                                                                                 |
| ------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pilot school onboarding executed with a **Go** verdict | **Open** | [`pilot-completion-report.md`](pilot-completion-report.md) has no cohort filled in — the pilot has not run against a live prod                                                                                           |
| Prod environment deployed and verified                 | Met      | fly.io production, deployed and smoke-checked by `fly-production-deploy.yml`; first operator created 2026-11-10 (`infra/fly/README.md`)                                                                                  |
| Production secrets and web build variables supplied    | **Open** | [`../production-secrets.md`](../production-secrets.md), `prod` GitHub Environment (`infra/fly/README.md#secrets`) — the deploy fails by name on a missing required secret; optional ones (OAuth, Stripe) need confirming |

GA does not start from zero once these close — the pilot's own success-criteria queries, feedback
loop, and incident handling are the same mechanisms this checklist's go/no-go review reuses. A
**Pause** or **Stop** verdict on the pilot blocks this checklist outright; do not begin GA review
on a paused or stopped pilot.

## Canonical naming

Same conventions as [`launch/README.md`](README.md): `local | prod` (never "live" as an
environment token — "live" below always means "verified running against real
infrastructure", not an environment name), a school by `app.schools.slug`, metric names fixed to
`staff_activation_rate` / `daily_attendance_usage` / `sev_incident_count` where the pilot's numbers
feed this review. Checklist item names below (`nfr-verification`, `security-pass`, `pentest`,
`dr-drill`, `on-call`, `status-page`, `store-apps`, `pricing`, `support-workflow`) are the anchors
this doc and any tracking issue should use — do not invent synonyms.

## The eight gate items

Each item: what closes it, current status, evidence.

### 1. NFR verification evidence

**Closes when:** every formalized NFR has a document stating its target and a measurement run
against a real (not local-Docker) environment confirming it, or an explicit accepted-gap note.

**Status: Open.**

- `NFR-05` (cross-tenant isolation) is the only formalized NFR in the repo
  (`docs/testing/load-test-scenarios.md`'s own line: "this repo has exactly one formalized NFR
  document"). It has real, continuous evidence: the ST-051 probe
  (`docs/security/NFR-05_cross_tenant_isolation.md`) runs on every PR as the `cross-tenant-security`
  CI job — this one is genuinely close to closed, but "verified" for GA means it also needs to be
  reconfirmed against the pilot cohort's real prod data before sign-off, not just CI's synthetic
  two-school fixture.
- **NFR-01 (latency) and NFR-02 (error-rate/availability) have no formal document.**
  `docs/testing/load-test-scenarios.md` uses proposed defaults pending "the real NFR-01/02
  numbers, to replace this doc's proposed defaults" (its own words) — nobody has supplied them.
- **The load-test suite that would produce the evidence has never run for real.**
  `load-test-scenarios.md`: "the suite has never been run against a real Postgres/API stack" — and
  there is no staging environment to run it against.

**Evidence path once closed:** `docs/testing/load-test-scenarios.md` run output against prod (or a
prod-shaped environment stood up for it), plus a real NFR-01/NFR-02 document replacing the proposed defaults.

**Compiled evidence pack (ST-295):**
[`nfr-verification-evidence-pack.md`](nfr-verification-evidence-pack.md) — the formal verification
run this item asks for. It found the same thing this section already says (no load run exists),
plus a finding this section didn't have yet: this repo has no `SAD §5` and only five NFR IDs are
referenced anywhere in it (NFR-01/02/03/05/11), not fifteen. Verdicts every one of those five, plus
the security/DR/load-test/accessibility/locale/query-performance evidence this repo has under other
names, against a gap register with owner and remediation target per gap — nine gaps remain open,
two were closed while compiling the pack (a missing NFR-11 doc, authored and run; a believed
CI-wiring gap that further checking showed was never real). Status stays **Open** — closing two
items doesn't change that NFR-01/02/03 have no real target and no load run exists to measure
against; the pack documents the real state, it does not manufacture GA readiness.

### 2. Security pass + pen test closure

**Closes when:** the internal pass has zero open critical/high, **and** an external pen test has
been contracted, executed, reported, and every critical/high from it remediated and retested.

**Status: Half Met, half Open.**

- Internal pass: **Met.** [`security/st-249-security-pass.md`](../security/st-249-security-pass.md)
  — 16 findings, zero critical/high open at exit, cross-tenant suite green (462 tests), full
  history secret scan clean (0 real secrets in 541 commits).
- External pen test: **Open.**
  [`security/st-250-external-pentest-commissioning.md`](../security/st-250-external-pentest-commissioning.md)'s
  own status table: vendor not contracted, engagement not executed, report not received,
  remediation/retest not started, redacted summary not published. The scope and ROE checklist are
  ready; the two pieces of infrastructure it was scoped against (the AWS WAF allowlist and a seeded
  two-tenant staging) went with AWS and need replacing — and the engagement itself is a procurement action nothing in this repo can complete.

**Evidence path once closed:** signed engagement contract, vendor report, this repo's own
`st-250-<vendor>-<year>-findings.md` findings-and-fixes log with zero open critical/high, retest
confirmation per finding, published redacted summary
(`docs/security/pentest_redacted_summary_template.md`).

### 3. DR drill report

**Closes when:** a drill has run against real infrastructure and produced a measured RPO/RTO
against a target. `SAD_30_backup_policy.md` no longer states one: the AWS-era RPO ≤ 5 min / RTO ≤ 4 h
targets went with AWS, and RPO/RTO for Supabase, R2 and Redis Cloud is not yet defined.

**Status: Open — no DR runbooks for the current stack, nothing measured.**

[`dr/st-266-game-day-drill-report.md`](../dr/st-266-game-day-drill-report.md) states its own result
up front: "the drill did not run against real infrastructure, and no real RPO/RTO number was
measured." It drilled the AWS stack (RDS, AWS Backup), which was retired; the six scenario
runbooks went with it, and none exist yet for Supabase, Redis Cloud and R2
([`dr/README.md`](../dr/README.md)). The `dr-gap` issues it filed (#278–#287) describe AWS gaps.

**Evidence path once closed:** DR runbooks written for the fly/Supabase stack, then a drill against
them reporting a real RPO/RTO number, filed as a new dated report next to `st-266`'s — not an edit
of it, which stands as the honest record of the first attempt.

### 4. On-call staffed

**Closes when:** the minimum roster (four people per `on-call-rotation.md`) is named in the actual
on-call provider, the rotation is live, and one full handover has happened without incident.

**Status: Open — roster unresolved.**

[`on-call-rotation.md`](../on-call-rotation.md) specifies the contract (one primary + one
secondary always staffed, weekly cadence, Sunday 10:00 `Asia/Amman` handover, 15-minute
critical-page acknowledgment), but no on-call provider or paging path exists since the AWS
Alertmanager pipeline was retired, and no names are recorded here by design (`launch/README.md`'s
ownership convention). Nobody has confirmed that a roster of four exists at all.

**Evidence path once closed:** a dated confirmation (screenshot or export from the on-call
provider, not asserted from memory) that the roster and schedule match `on-call-rotation.md`, plus
one completed handover.

### 5. Status page live

**Closes when:** a public status page is live at a URL schools can find, and the incident
templates ([`incident-comms-templates.md`](../incident-comms-templates.md)) are posted there.

**Status: Open — no status page exists.**

The self-hosted page built for this item (S3 + CloudFront, Lambdas, SES subscriber email) was AWS
infrastructure that was never applied and has been retired. Nothing replaces it yet.

**Evidence path once closed:** the status page's public URL resolving, and a test incident posted
and resolved on it.

### 6. Store apps approved

**Closes when:** both the App Store Connect and Play Console app records have a `production`
release approved and live (not merely uploaded to an internal track).

**Status: Open — lanes written, no store accounts exist.**

[`mobile-release.md`](../mobile-release.md)'s own Status line: "the lanes are written, not yet
exercised against real store accounts. Nothing here has uploaded a build to TestFlight or Play."
Concretely missing: the 7+ repository secrets every `mobile-release.yml` job needs, an App Store
Connect app record and a Play Console app entry with `internal`/`production` tracks created (both
stores refuse an API upload to a track that has never had a manual first build), the one-time iOS
Xcode signing wiring, and a committed `Gemfile.lock`.

**Evidence path once closed:** both stores' public listing URLs showing an approved `production`
release, plus the `mobile-v*` tag and CI run that shipped it.

### 7. Pricing live

**Closes when:** the Stripe account is in live mode, `app.plans`/prices are synced
(`price-sync-service.ts`) against real Stripe products, and a real checkout has completed
end-to-end on a non-test card.

**Status: Open — mechanism complete, no live payment account confirmed.**

The subscriptions module is real and reasonably deep: plan/seat checkout
(`subscriptions/routes/checkout-routes.ts`, `school-checkout-routes.ts`), webhook processing with
signature verification (`stripe/webhook-processor.ts`, covered by
`__tests__/webhook-signature.test.ts`), plan-price sync (`services/price-sync-service.ts`),
cancellation and grace-period states documented for admins in
`docs/help/billing/subscriptions.md`. What's unconfirmed: whether a Stripe account exists in live
(non-test) mode at all — `docs/runbooks/secrets-conventions.md` does not document a
`STRIPE_SECRET_KEY`/webhook-secret entry the way it documents every other credential class, which
is itself a gap to close before this can be "live" rather than "code-complete."

**Evidence path once closed:** a `STRIPE_SECRET_KEY` (live) entry added to
`secrets-conventions.md` following its existing format, `price-sync-service.ts` run against prod
with `syncedPlans`/`syncedPrices` counts matching `app.plans`, and one real checkout session
completed and reconciled against a Stripe dashboard event.

### 8. Support workflow ready

**Closes when:** there is a documented intake channel, triage SLA, and escalation-to-engineering
path for a live customer support request — distinct from the pilot's internal `pilot-feedback`
GitHub-issue loop, which does not scale to every school and was never meant to.

**Status: Open — workflow now documented, intake channel not yet live.**

[`support/README.md`](../support/README.md) now defines the intake channels
(a support mailbox, address not yet chosen, plus the in-app help center linking out to it — a dedicated help widget is deliberately deferred, see that
file's "Help widget" section), the severity/SLA table (reusing `on-call-rotation.md`'s
`critical`/`warning`/`info` vocabulary, not a second scale), the triage disposition loop
(generalizing the pilot's own `backlog`/`sev`/`wontfix`/`training` dispositions), a macro library
covering the top 7 predicted issues ([`support/macro-library.md`](../support/macro-library.md)),
and the escalation path into `on-call-rotation.md`'s existing `critical` page — no separate
support-incident process invented. What's still open, per that directory's own "Known gaps":
`VITE_MARKETING_CONTACT_EMAIL` is unset in every environment (`apps/web/src/lib/config.ts` — the
About/Contact page currently reads "Contact address not yet configured"), the mailbox itself is
unprovisioned, and [`support/drill.md`](../support/drill.md) — the intake→triage→resolution and
SEV→on-call-page test script — has never been run.

**Evidence path once closed:** `VITE_MARKETING_CONTACT_EMAIL` set and deployed, the mailbox
receiving mail, and [`support/drill.md`](../support/drill.md) run once for real (its own
post-drill record filled in) as evidence the path in `support/README.md` actually works, not just
reads as though it would.

## Go/no-go review

Held only once every item above reads **Met** with a linked evidence artifact — not scheduled
against a calendar date, against evidence existing.

1. **Pre-read**: this document, current state, circulated to attendees at least 2 working days
   ahead — no live-reading a checklist in the meeting.
2. **Attendees (roles, not names — resolve at kickoff)**: Pilot lead (chairs — same role as the
   pilot's own verdict owner, since GA is a direct continuation), on-call primary, a security
   owner (whoever owns `st-249`/`st-250`), an engineering owner who can speak to the deploy
   mechanism's actual state.
3. **Per item**: state Met/Open, evidence link, and — for anything marked Met since the last
   review — who verified it and when. An item flips to Met only with a linked artifact in this
   review's minutes, never a verbal "yes."
4. **Verdict**, same vocabulary as the pilot's ([`pilot-school-onboarding.md`](pilot-school-onboarding.md#verdict-rules)):
   - **Go** — all eight items Met, dependency gate Met. Proceed to launch execution below.
   - **Pause** — a named, closable blocker with an owner and a re-check date; do not re-run the
     full review until that date.
   - **Stop** — a blocker with no remediable path on any near-term horizon (e.g. a Stop verdict on
     the pilot itself); GA is off the table until the underlying condition changes.
5. **Record the verdict** in the sign-off block below, in this file, committed — not in meeting
   notes that live outside the repo.

## Launch execution with monitoring watch

Only after a **Go** verdict. This section is the sequence for the day of, not a description of
mechanisms already documented elsewhere — those are: [`infra/fly/README.md`](../../../infra/fly/README.md#deploying)
(the deploy; no rollback procedure is defined for fly yet), [`incident-comms-templates.md`](../incident-comms-templates.md)
(incident updates), and Sentry (org `studafy-limited`) plus Axiom (dataset `studafy-logs`) for what
a person watches — there is no alert catalog or dashboard set on fly yet.

1. **T-1 day**: on-call primary/secondary for the launch window confirmed and reachable; an
   incident update drafted (not posted) using the "Scheduled maintenance" template so it's one click
   away if launch needs to be visible.
2. **T-0**: run **Production deploy (fly.io)**. It already deploys one service at a time (scanner,
   migrations, then `api` → `realtime` → `workers` → `web`) and ends with a smoke check of the api
   and web `/healthz`.
3. **Watch window**: minimum 2 hours of active watch (not "alerts will page if something's wrong")
   against Sentry's error stream and the API's request logs in Axiom (error rate and latency), plus
   the workers' logs if any async workers shipped in the same change.
4. **Any SEV during the watch window**: same incident path as the pilot's
   ([`pilot-school-onboarding.md`](pilot-school-onboarding.md#incident-exit)) — leave this runbook,
   ship a fix through the deploy workflow or follow [`dr/README.md`](../dr/README.md), post an
   incident update, record it.
5. **Exit**: watch window elapsed clean, or an incident reached a stable resolved state with a
   follow-up ticket filed. Either way, a closing note goes in the sign-off block below — GA is
   "launched," not "launched and forgotten."

## Sign-off block — fill in at the actual review, not before

| #   | Item                             | Status at review | Evidence link | Signed off by (role) | Date |
| --- | -------------------------------- | ---------------- | ------------- | -------------------- | ---- |
| 1   | NFR verification evidence        |                  |               |                      |      |
| 2   | Security pass + pen test closure |                  |               |                      |      |
| 3   | DR drill report                  |                  |               |                      |      |
| 4   | On-call staffed                  |                  |               |                      |      |
| 5   | Status page live                 |                  |               |                      |      |
| 6   | Store apps approved              |                  |               |                      |      |
| 7   | Pricing live                     |                  |               |                      |      |
| 8   | Support workflow ready           |                  |               |                      |      |

**Verdict:** (Go / Pause / Stop) — reason:

**Launch execution record** (filled only on Go): deploy timestamps per service, watch-window
start/end, incidents (none / list with follow-up links).

## Known gaps

Item 8 (support workflow) is now documented (`support/README.md`) — pure writing, no external
account needed, so it moved first. The remaining seven items each need something this repo cannot
produce on its own: DR runbooks and a status page for the fly stack, a contracted pentest vendor, live App Store/Play
accounts, a live Stripe account, and a confirmed on-call roster. Closing any of them is a
real-world action outside this codebase, evidenced back into this checklist once it happens — not
a documentation task.
