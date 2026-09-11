# Support workflow

How a live customer (a school, not a pilot cohort) reaches support, how that request is triaged,
what response time it's owed, and the exact point it becomes a tracked engineering issue or a
paged incident. This generalizes the pilot's `pilot-feedback` GitHub-issue loop
([`launch/pilot-school-onboarding.md`](launch/pilot-school-onboarding.md#4-feedback-loop-weeks-14))
into something that scales past 2–3 hand-held schools — same shape, no invented second vocabulary.

## Status — read this before treating this as "ready"

**No support request has ever flowed through this workflow.** Same posture as every other launch
document in this repo: what's below is the specification, accurate to what exists in the codebase
today, not a report of it having run. Concretely, the one channel a school could use today is
unconfigured:

- `apps/web`'s only public contact surface is the About/Contact page's `mailto:` link
  (`apps/web/src/routes/marketing/AboutPage.tsx`), driven by `VITE_MARKETING_CONTACT_EMAIL`
  (`apps/web/src/lib/config.ts`). That variable is unset in this repo's history — the page's own
  fallback renders "Contact address not yet configured" when it's empty, and it always has been.
- No support-specific env var, ticketing system, or intake form exists anywhere in this
  repo — this document is the first attempt to define one.

**Before this closes the GA checklist's item 8** (`launch/ga-launch-checklist.md`), someone still
has to: set `VITE_MARKETING_CONTACT_EMAIL` (or a dedicated support address — see
[Intake channel](#intake-channel)) in every environment's deploy config, and run this workflow
against at least one real request to confirm the triage/escalation path below actually works, not
just reads as though it would.

## Intake channel

**One channel, one inbox — not a ticketing product.** A dedicated mailbox beats a third-party
helpdesk at this stage: fewer moving parts (KISS), and this repo self-hosts the equivalent
mechanism already for the status page (`infra/terraform/modules/monitoring/status_page.tf` sends
status mail from `status@send.studafy.com`, the domain `dns_ses_domain` sets in
`environments/prod/prod.tfvars`) — a support mailbox on the same verified SES domain is the same
mechanism, reused, not a new one invented:

- **Address:** `support@send.studafy.com` — same domain, same SES identity the status page already
  verifies. Not yet provisioned; provisioning it is an environment-config change (an SES receiving
  rule or a forward to wherever triage actually reads mail), not a code change.
- **Public surface:** `apps/web`'s About/Contact page, once `VITE_MARKETING_CONTACT_EMAIL` is set
  to the address above in each environment's build config. School admins also see it from
  `docs/help/` — the help center's own pages should link out to it wherever an article ends in "if
  this doesn't resolve it, contact support" rather than leaving the reader stuck.
- **Not in scope for this channel:** anything already self-service in `docs/help/` — billing
  questions answered by `docs/help/billing/subscriptions.md`, timetable/finance workflow questions
  answered by their own help articles. Support intake is for what the help center couldn't answer,
  not a shortcut around it.

## Severity and response-time SLA

Reuses [`alert-catalog.md`](alert-catalog.md#severity-matrix)'s closed three-value vocabulary
(`critical` / `warning` / `info`) so a severity means the same thing whether it came from a
Prometheus rule or a school's email — no second scale to keep in sync with the first.

| Severity   | What it means for a support request                                                                                                              | First response | Out of hours                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------- |
| `critical` | A school cannot use core functionality right now (attendance, grading, billing) for reasons that look like a platform issue, not a training gap. | 15 min         | **Pages the on-call primary** — same path as any other `critical`, `on-call-rotation.md` |
| `warning`  | A real defect or a blocked workflow, but the school has a workaround or it's not blocking today.                                                 | 1 working day  | Queued; nobody is woken                                                                  |
| `info`     | A question, a training gap, or a feature request — nothing broken.                                                                               | 2 working days | None                                                                                     |

**What promotes a request to `critical`.** The same test `alert-catalog.md` already applies to
alerts: is a human needed in the next fifteen minutes, and is there something they can do? "My
grades look wrong" is `warning` until someone confirms it's not one teacher's data-entry error; it
becomes `critical` the moment it's confirmed as a platform bug affecting live grading, or as
anything touching cross-tenant isolation (`security/NFR-05_cross_tenant_isolation.md`) — a
cross-tenant finding is `critical` unconditionally, regardless of how it arrived.

## Triage

1. **Mailbox check**: at least once per working day, more often once request volume justifies it —
   this is the first thing to tighten once real volume exists, not a number to guess in advance.
2. **Every request gets a disposition**, same four values the pilot's feedback loop already proved
   out (`pilot-school-onboarding.md` §4), now the permanent vocabulary instead of a pilot-only one:
   - `backlog` — a real defect or gap, not urgent; filed as a GitHub issue, label `support`.
   - `sev` — crosses into `critical` above; leaves this workflow for the incident path (next
     section).
   - `wontfix` — closed with a written reason back to the school. Silence is not a disposition.
   - `training` — a usage/teaching gap, not a defect; answered directly, and if the help center
     didn't already cover it, that's its own `backlog` issue against `docs/help/`.
3. **No request sits undispositioned past its SLA above.** A request that will take longer to
   actually resolve still gets an initial response inside its SLA window acknowledging it and
   naming the disposition — the SLA is for first response, not for the fix.

## Escalation into an incident

A `sev` disposition (or anything landing directly as `critical`) leaves this document and enters
the same incident machinery every other `critical` already uses — there is deliberately no
separate "support incident" process:

- Page per [`on-call-rotation.md`](on-call-rotation.md)'s `critical` path.
- Run whichever runbook the failure shape demands — `deploy-rollback.md` or the relevant
  [`dr/`](dr/) runbook.
- Post to the public status page per [`incident-comms-templates.md`](incident-comms-templates.md).
- Any cross-tenant or security-adjacent finding additionally follows
  `security/st-249-security-pass.md`'s severity/disposition format for the write-up.
- File the follow-up ticket before closing — a resolved incident with no linked follow-up is not
  actually closed, same rule the pilot's incident-exit path already states.

## Ownership — roles, not people

Same convention as every other runbook in this repo (`dr/README.md`, `launch/README.md`): no
names, resolve the role to a person when this workflow is actually staffed.

| Role              | Responsibility                                                                 | Interim proxy                                                             |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Support triage    | Checks the mailbox, dispositions every request inside its SLA                  | Rotating; whoever owns the `pilot-feedback` backlog today extends to this |
| On-call primary   | Owns anything dispositioned `sev` from the moment of escalation                | `on-call-rotation.md`'s existing primary — no separate rotation           |
| Help-center owner | Closes `training`-disposition gaps by writing or fixing a `docs/help/` article | Whoever owns `docs/help/README.md`'s conventions today                    |

## Known gaps

- **No intake channel is actually live** — `VITE_MARKETING_CONTACT_EMAIL` unset, `support@send.studafy.com` unprovisioned. Closing this is the single blocker before the rest of this document can be exercised for real.
- **No volume has ever flowed through this**, so the "at least once per working day" mailbox-check cadence and the SLA numbers above are starting points, not measured — revisit both once real request volume exists, the same way `on-call-rotation.md`'s own rotation size is a starting minimum, not a proven-sufficient one.
- **No dashboard or ticket count exists** for support-labelled issues — same gap the pilot's own feedback loop already named for its metrics; a panel is worth building once volume, not workflow definition, is the bottleneck.
