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
  blocks starting until prod is verified live, and [`pilot-completion-report.md`](pilot-completion-report.md)
  is a template with no numbers filled in. There is no Go verdict to build a GA launch on.
- **Prod has never been applied.** `environment-matrix.md`'s honesty note and the ST-266 drill
  report ([`dr/st-266-game-day-drill-report.md`](../dr/st-266-game-day-drill-report.md)) both say
  the same thing independently: no AWS account had ever been applied to, from any environment in
  this repo's history, until **2026-09-11**, when `infra/terraform/bootstrap` was applied for real
  against account `862910165270` — state buckets for all three environments, the Route53 zone,
  GitHub OIDC provider, and per-environment `terraform-apply` IAM roles now exist. That first real
  apply surfaced and fixed a genuine bug (`aws_iam_role_policy_attachment.terraform_power_user`
  and `aws_iam_role_policy.terraform_iam` used a whole for_each'd resource as their own `for_each`
  source, which `terraform import` cannot resolve on an empty account — fixed to iterate
  `local.environments` instead, the same static set the role itself already uses). The **network
  → data-tier → app-tier** modules any real environment (`dev`/`staging`/`prod`) needs are still
  unapplied — this is the account-wide plumbing bootstrap requires, not a running environment.
- **There is no deploy path yet.** [`deploy-rollback.md`](../deploy-rollback.md)'s own Status line:
  "Not runnable yet" — no ECS cluster, execution role, or ALB target group exists in
  `infra/terraform`, and the ECR repository policy denies the task execution role. "Launch
  executed with monitoring watch" has no deploy mechanism to execute yet.

Treat every "Open" row below as exactly that — not a formality left to tidy up before a review,
but a real artifact (a contract, a report, a named roster, a provisioned account) that does not
exist in this repo or its history. Running this checklist today would mean fabricating evidence,
which is worse than leaving the row open.

## Dependency gate

| Dependency                                             | Status   | Evidence                                                                                                                                                                               |
| ------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pilot school onboarding executed with a **Go** verdict | **Open** | [`pilot-completion-report.md`](pilot-completion-report.md) has no cohort filled in — the pilot has not run against a live prod                                                         |
| Prod environment applied to real AWS and verified      | **Open** | `environment-matrix.md` — `infra/terraform/bootstrap` applied 2026-09-11 (state buckets, DNS zone, OIDC, IAM roles); network/data/app-tier modules for any environment still unapplied |

GA does not start from zero once these close — the pilot's own success-criteria queries, feedback
loop, and incident handling are the same mechanisms this checklist's go/no-go review reuses. A
**Pause** or **Stop** verdict on the pilot blocks this checklist outright; do not begin GA review
on a paused or stopped pilot.

## Canonical naming

Same conventions as [`launch/README.md`](README.md): `dev | staging | prod` (never "production" or
"live" as an environment token — "live" below always means "verified running against real
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
  `load-test-scenarios.md`: "the suite has never been run against a real Postgres/API stack" — no
  staging run exists either.

**Evidence path once closed:** `docs/testing/load-test-scenarios.md` run output against staging or
prod, plus a real NFR-01/NFR-02 document replacing the proposed defaults.

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
  remediation/retest not started, redacted summary not published. The scope, ROE checklist, and
  the two pieces of infrastructure it needs (WAF allowlist mechanism, seeded two-tenant staging)
  are ready — the engagement itself is a procurement action nothing in this repo can complete.

**Evidence path once closed:** signed engagement contract, vendor report, this repo's own
`st-250-<vendor>-<year>-findings.md` findings-and-fixes log with zero open critical/high, retest
confirmation per finding, published redacted summary
(`docs/security/pentest_redacted_summary_template.md`).

### 3. DR drill report

**Closes when:** a drill has run against real infrastructure and produced a measured RPO/RTO
against the target (RPO ≤ 5 min / RTO ≤ 4 h per `SAD_30_backup_policy.md`).

**Status: Open — mechanism verified, nothing measured.**

[`dr/st-266-game-day-drill-report.md`](../dr/st-266-game-day-drill-report.md) states its own result
up front: "the drill did not run against real infrastructure, and no real RPO/RTO number was
measured." What is closed: `terraform validate` passes for the whole configuration including
`module.backup`, every runbook script was read in full and cross-referenced, and ten concrete gaps
were found and filed as GitHub issues (`dr-gap` label, #278–#287) — gap #1 of those, "no AWS
account has ever been applied to," blocks every other one.

**Evidence path once closed:** a re-run of the same drill against an applied prod (or a prod-shaped
staging), reporting a real RPO/RTO number, filed as a new dated report next to this one — not an
edit of `st-266`'s, which stands as the honest record of the first attempt.

### 4. On-call staffed

**Closes when:** the minimum roster (four people per `on-call-rotation.md`) is named in the actual
on-call provider, the rotation is live, and one full handover has happened without incident.

**Status: Open — roster unresolved.**

[`on-call-rotation.md`](../on-call-rotation.md) specifies the contract (one primary + one
secondary always staffed, weekly cadence, Sunday 10:00 `Asia/Amman` handover, 15-minute
critical-page acknowledgment) but the schedule itself "lives in the on-call provider, not in this
repo" and no names are recorded here by design (`launch/README.md`'s ownership convention). Nobody
has confirmed the provider-side schedule actually matches this spec, or that a roster of four
exists at all — that confirmation is exactly what `alert-catalog.md`'s "noisy alert review" agenda
item calls for when the two drift.

**Evidence path once closed:** a dated confirmation (screenshot or export from the on-call
provider, not asserted from memory) that the roster and schedule match `on-call-rotation.md`, plus
one completed handover.

### 5. Status page live

**Closes when:** `status_page_enabled = true` has been applied to prod, the public URL resolves,
`status-page-sync` is confirmed reflecting real synthetic-probe state, and (if subscriber email is
wanted) SES is provisioned.

**Status: Open — built, not applied anywhere.**

The mechanism is real and complete: self-hosted S3 + CloudFront, four Lambdas
(`infra/terraform/modules/monitoring/status_page.tf`), `status-page-sync` polling every minute,
manual incident posting via `status-page-incident`, subscriber double opt-in
(`docs/runbooks/incident-comms-templates.md` documents the human half). None of it is running —
same "written, not applied" state as every other piece of `infra/terraform` per
`environment-matrix.md`. It also has no custom domain wired (served on CloudFront's own hostname)
and SES-backed subscriber email is conditional on `ses_domain_identity_arn`, unset today.

**Evidence path once closed:** `terraform output status_page_url` printing a real URL that
resolves, `status-page-sync`'s CloudWatch logs showing real alarm reads on the applied environment.

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

[`support-workflow.md`](../support-workflow.md) now defines the intake channel
(`support@send.studafy.com`, the same verified SES domain the status page already uses), the
severity/SLA table (reusing `alert-catalog.md`'s `critical`/`warning`/`info` vocabulary, not a
second scale), the triage disposition loop (generalizing the pilot's own `backlog`/`sev`/`wontfix`/
`training` dispositions), and the escalation path into `on-call-rotation.md`'s existing `critical`
page — no separate support-incident process invented. What's still open, per that document's own
"Known gaps": `VITE_MARKETING_CONTACT_EMAIL` is unset in every environment
(`apps/web/src/lib/config.ts` — the About/Contact page currently reads "Contact address not yet
configured"), the mailbox itself is unprovisioned, and the workflow has never carried a real
request end to end.

**Evidence path once closed:** `VITE_MARKETING_CONTACT_EMAIL` set and deployed, the mailbox
receiving mail, and at least one real support request carried through triage to a disposition as
evidence the path in `support-workflow.md` actually works, not just reads as though it would.

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
mechanisms already documented elsewhere — those are: [`deploy-rollback.md`](../deploy-rollback.md)
(deploy + the two rollback mechanisms), [`incident-comms-templates.md`](../incident-comms-templates.md)
(status page posting), [`alert-catalog.md`](../alert-catalog.md) (what a person watches).

1. **T-1 day**: on-call primary/secondary for the launch window confirmed and reachable; status
   page incident drafted (not posted) using the "Planned maintenance" template so it's one click
   away if launch needs to be visible.
2. **T-0**: deploy per `deploy-rollback.md`'s sequence, one service at a time
   (`api` → `realtime` → `workers`), `aws ecs wait services-stable` confirmed for each before the
   next — never all three in parallel on a first GA cutover.
3. **Watch window**: minimum 2 hours of active watch (not "alerts will page if something's wrong")
   against the SLO panels `alert-catalog.md`'s API SLOs section defines
   (`ApiAvailabilityFastBurn`/`SlowBurn`, `ApiLatencyFastBurn`/`SlowBurn`), the status page's own
   badges, and the queue-depth alarms if any async workers shipped in the same change.
4. **Any SEV during the watch window**: same incident path as the pilot's
   ([`pilot-school-onboarding.md`](pilot-school-onboarding.md#incident-exit)) — leave this runbook,
   run `deploy-rollback.md` or the relevant `dr/` runbook, post to the status page, record it.
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

Item 8 (support workflow) is now documented (`support-workflow.md`) — pure writing, no external
account needed, so it moved first. The remaining seven items each need something this repo cannot
produce on its own: an applied AWS account, a contracted pentest vendor, live App Store/Play
accounts, a live Stripe account, and a confirmed on-call roster. Closing any of them is a
real-world action outside this codebase, evidenced back into this checklist once it happens — not
a documentation task.
