# Incident comms templates (ST-264)

What to post to the public status page, and when, for the five components it shows: `api`, `web`,
`realtime`, `ai`, `billing`. This is the human half of the status page — the mechanical half (which
alarm flips which component automatically) is
[`infra/terraform/modules/monitoring`](../../infra/terraform/modules/monitoring)'s "Public status
page" section and `status_page.tf`. The page itself is self-hosted (S3 + CloudFront, `terraform
apply` is the entire deploy) — there is no third-party status-page account anywhere in this.

Mechanism source: `infra/terraform/modules/monitoring/status_page.tf`,
`infra/terraform/modules/monitoring/lambda/status-page-incident/index.mjs`,
[`alert-catalog.md`](alert-catalog.md) (severity vocabulary, alarm-to-runbook links),
[`on-call-rotation.md`](on-call-rotation.md) (who is doing this).

## What updates itself, and what needs a person

| Component  | Flips automatically on synthetic/probe failure                     | A person must post the incident |
| ---------- | ------------------------------------------------------------------ | ------------------------------- |
| `web`      | Yes (`login-page` check)                                           | Yes — see below                 |
| `api`      | Yes (`healthz`/`oauth-start`/`invitation-verify`)                  | Yes                             |
| `billing`  | Yes (`checkout-page` check)                                        | Yes                             |
| `realtime` | Yes (the ST-149 probe's SLO alarm)                                 | Yes                             |
| `ai`       | Partially — see "The `ai` badge is narrower than the others" below | Yes, always                     |

**The component badge and the incident are two different things, and only one of them is
automatic.** `status-page-sync` (every minute) flips a component's badge between `operational` and
`major_outage` by itself — that satisfies "synthetic failure reflects on page automatically". It
never creates, updates, or resolves an **incident**, and it never sends a subscriber email by
itself (see "Subscriber emails" below): those need a person to POST to `status-page-incident`,
using the templates below. A red badge with no incident text is an accurate but useless page to a
subscriber trying to understand what's happening — post the incident as soon as you've confirmed
the badge is telling the truth (`alert-catalog.md`'s
[test-firing an alert](alert-catalog.md#test-firing-an-alert) section covers "is this real" triage
for the same alarms).

**The `ai` badge is narrower than the others.** `ai-health` (`synthetics.tf`) checks that apps/api's
`/api/ai/health` route answers 200 — that AI_LLM_ENABLED is on and the process is up. It does
**not** call Anthropic, so it cannot see a live Anthropic-provider outage: during one, the `ai`
badge can legitimately stay green (the route is fine; the provider it calls is not) while AI
features are actually failing for users. Detect that the way
[`ai-provider-outage.md`](ai-provider-outage.md) already describes (BullMQ failure rate, the retry
logger, the per-school circuit breaker, Anthropic's own status page), then post the incident
yourself — the badge will not do it for you.

## Posting an update

`POST` to `status-page-incident`'s Function URL (`terraform output -raw
status_page_incident_function_url` — `null` if SES isn't provisioned for this environment, see
below) with header `x-status-page-admin-token: <STATUS_PAGE_ADMIN_TOKEN>` (the `monitoring`
app-secrets container — same place Alertmanager's receiver URLs live, `secrets-conventions.md`) and
a JSON body:

```bash
curl -X POST "$(terraform output -raw status_page_incident_function_url)" \
  -H "x-status-page-admin-token: $STATUS_PAGE_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "title": "Elevated errors on checkout",
    "components": ["billing"],
    "impact": "major",
    "status": "investigating",
    "body": "We are investigating reports of degraded checkout. Some users may see errors completing payment."
  }'
```

The response's `incident.id` is what every follow-up update on the _same_ incident carries as
`incidentId` instead of `title`/`components`/`impact` (those are only read when creating a new
incident):

```bash
curl -X POST "$(terraform output -raw status_page_incident_function_url)" \
  -H "x-status-page-admin-token: $STATUS_PAGE_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "incidentId": "<id from the create response>",
    "status": "resolved",
    "body": "Checkout has been operating normally since 14:32 UTC."
  }'
```

Each POST both updates the public page (`incidents.json`) and emails every confirmed subscriber
(see "Subscriber emails" below) — posting the incident **is** sending the email; there is no
separate step.

Four states, in order, one incident:

1. **Investigating** — post the moment you're confident this is real (not a flapping check, not a
   drill — `alert-catalog.md`'s noisy-alert judgment applies here too). Say what's affected, not
   why; you don't know why yet.
2. **Identified** — once you know the cause, even provisionally. This is the update that turns "we
   know something's wrong" into "we know what's wrong", which is the update subscribers are
   actually waiting for.
3. **Monitoring** — once a fix is applied and the component's badge would go green on its own (or
   you've flipped it by hand for `ai`, where nothing does that automatically — see above). Say what
   you did and how long you'll watch before calling it resolved.
4. **Resolved** — once the watch period is over and nothing recurred. Close the loop with a one-line
   summary; save the postmortem for wherever this repo's incident retro process lives, not the
   public page.

**Match `impact` to the alert severity that triggered it**
(`alert-catalog.md`'s [severity matrix](alert-catalog.md#severity-matrix)): every synthetic-check
and probe alarm feeding this status page is `critical` (see `status_page.tf`'s header), so `impact`
should be at minimum `"major"` for a single affected component, `"critical"` if more than one is
affected at once. `impact` accepts `"none"`/`"minor"`/`"major"`/`"critical"`. Do not under-state
impact to make the page look calmer than the alarm says it is.

## Templates

Copy the `body` text, fill in the bracketed parts, paste into the `curl` call above. Keep them
short — a subscriber reads this on a phone during an outage, not at their desk.

### Investigating

```
We're investigating reports of [degraded / unavailable] [component name]. Some users may see
[specific symptom, e.g. "errors submitting grades" / "checkout requests timing out"]. We'll post
an update as soon as we know more.
```

### Identified

```
We've identified the cause as [one sentence, plain language — no internal alarm names, ticket
numbers, or stack traces]. We're working on a fix. Next update within [30 minutes / 1 hour].
```

### Monitoring

```
A fix has been applied and [component name] is recovering. We're continuing to monitor before
marking this resolved. If you're still experiencing issues, they should clear within [X minutes].
```

### Resolved

```
This incident is resolved. [Component name] has been operating normally since [time]. We
apologize for the disruption.
```

### AI-specific addendum (append to Investigating/Identified when `ai` is the affected component)

`ai-health` cannot see a live Anthropic outage (see "The `ai` badge is narrower than the others"
above) — say so honestly rather than implying an automated check caught it:

```
AI-powered features (exam generation, [other AI surface]) are currently [degraded / unavailable].
This was detected via [BullMQ failure rate / provider status page / circuit breaker], not an
automated check — see internal runbook ai-provider-outage.md for the response in progress.
```

### Scheduled maintenance (not triggered by any alarm — post ahead of time, not reactively)

```
We have scheduled maintenance for [component name] on [date] from [start]–[end] [timezone]. You
may experience [brief disruption / no impact — service will remain available throughout]. We will
update this page if anything changes.
```

## Subscriber emails

Genuinely sent by this repo's own infrastructure via SES — not a third-party product, and not
something posting an incident has to remember to do separately, because it's the same POST:

1. A visitor enters their email on the public page. `status-page-subscribe` records them
   unconfirmed and emails a confirmation link — **double opt-in**: nobody receives an update email
   until they click it.
2. Clicking the link hits `status-page-subscription` (`?action=confirm`), which flips them to
   confirmed.
3. Every `status-page-incident` POST (above) emails every confirmed subscriber the `body` text,
   the affected components, and the new status — plus a per-subscriber unsubscribe link
   (`status-page-subscription?action=unsubscribe`) that removes them immediately, no confirmation
   needed.

**This only works where SES is provisioned for the environment** —
`ses_domain_identity_arn != null` (`dns_create_email_records = true` in that environment's
`.tfvars` — prod today, see `infra/terraform/environments/*/*.tfvars`). Where it isn't, `terraform
output status_page_incident_function_url` is `null`: there is nothing to POST to, and the public
page's subscribe form stays hidden (`app.js` only shows it when a subscribe URL was baked in at
deploy time). The page and automatic component sync work regardless — only the human/email half
needs SES.

**What "work" means for this acceptance criterion, concretely**: subscribe with a real address,
receive and click the confirmation email, then walk a real incident through Investigating →
Identified → Monitoring → Resolved (the `curl` sequence above) and receive all four emails, in
order, at that address. Run this drill once after first turning on SES for an environment, and
again any time the SES identity, the Lambdas' `SES_FROM_ADDRESS`, or `STATUS_PAGE_ADMIN_TOKEN` are
rotated — the same "prove the whole path, not just that the provider is up" reasoning
`alert-catalog.md`'s own [test-firing drill](alert-catalog.md#test-firing-an-alert) already applies
to paging.

## Known gaps

- **`ai-health` proves the feature is switched on, not that Anthropic is reachable.** Repeated here
  deliberately because it is the one place a reader might assume the status page is more automatic
  than it is. Closing this means building a synthetic surface that exercises the real provider path
  without making a real (costly) completion request every minute — scoped as future work.
- **No rate limiting on the public subscribe/confirm/unsubscribe endpoints.** Double opt-in bounds
  abuse to "someone gets one unwanted confirmation email", not an actual subscription — see
  `status_page.tf`'s header.
- **No custom domain.** The page is served at CloudFront's own `*.cloudfront.net` domain.
- **`incidents.json` keeps only the most recent 25 incidents** — this repo does not mirror incident
  history anywhere else.
