# Incident comms templates (ST-264)

What to post to the public status page, and when, for the five components it shows: `api`, `web`,
`realtime`, `ai`, `billing`. This is the human half of the status page — the mechanical half (which
alarm flips which component automatically) is
[`infra/terraform/modules/monitoring`](../../infra/terraform/modules/monitoring)'s "Public status
page sync" section and `status_page.tf`.

Mechanism source: `infra/terraform/modules/monitoring/status_page.tf`,
`infra/terraform/modules/monitoring/lambda/status-page-sync/index.mjs`,
[`alert-catalog.md`](alert-catalog.md) (severity vocabulary, alarm-to-runbook links),
[`on-call-rotation.md`](on-call-rotation.md) (who is doing this).

## What updates itself, and what needs a person

| Component  | Flips automatically on synthetic/probe failure    | A person must post the incident |
| ---------- | ------------------------------------------------- | ------------------------------- |
| `web`      | Yes (`login-page` check)                          | Yes — see below                 |
| `api`      | Yes (`healthz`/`oauth-start`/`invitation-verify`) | Yes                             |
| `billing`  | Yes (`checkout-page` check)                       | Yes                             |
| `realtime` | Yes (the ST-149 probe's SLO alarm)                | Yes                             |
| `ai`       | **No — no synthetic probe exists yet**            | Yes, always                     |

**The component badge and the incident are two different things, and only one of them is
automatic.** `status-page-sync` (every minute) flips a component's badge between `operational` and
`major_outage` by itself — that satisfies "synthetic failure reflects on page automatically". It
never creates, updates, or resolves an **incident**, and it never sends a subscriber email by
itself (see "Subscriber emails" below): those need a person to open the provider's incident editor
and post one, using the templates below. A red badge with no incident text is an accurate but
useless page to a subscriber trying to understand what's happening — post the incident as soon as
you've confirmed the badge is telling the truth (`alert-catalog.md`'s
[test-firing an alert](alert-catalog.md#test-firing-an-alert) section covers "is this real"
triage for the same alarms).

**`ai` never flips itself**, for a reason worth restating rather than hiding: this repo has no
synthetic probe against the Anthropic provider today —
[`ai-provider-outage.md`](ai-provider-outage.md)'s own Detection section says so directly. Detect an
AI outage the way that runbook already describes (BullMQ failure rate, the retry logger, the
per-school circuit breaker, Anthropic's own status page), then post both the incident **and** move
the `ai` badge by hand in the provider dashboard — nothing else will.

## Posting an update

Two ways, same content either way:

- **The provider's own incident editor** (the normal path — no API key needed, anyone with a
  provider login can do it). This is also the only way to move the `ai` badge, since nothing else
  writes to it.
- **The provider's REST API**, scripted, using `STATUS_PAGE_API_KEY` / `STATUS_PAGE_PAGE_ID` from
  the `monitoring` app-secrets container (`secrets-conventions.md`) — the same credential
  `status-page-sync` itself uses. Reach for this only when posting the same update to several
  components at once by hand would otherwise mean repeating the editor flow several times.

Either way, four states, in order, one incident:

1. **Investigating** — post the moment you're confident this is real (not a flapping check, not a
   drill — `alert-catalog.md`'s noisy-alert judgment applies here too). Say what's affected, not
   why; you don't know why yet.
2. **Identified** — once you know the cause, even provisionally. This is the update that turns "we
   know something's wrong" into "we know what's wrong", which is the update subscribers are
   actually waiting for.
3. **Monitoring** — once a fix is applied and the component's badge would go green on its own (or
   you've flipped it by hand for `ai`). Say what you did and how long you'll watch before calling it
   resolved.
4. **Resolved** — once the watch period is over and nothing recurred. Close the loop with a one-line
   summary; save the postmortem for wherever this repo's incident retro process lives, not the
   public page.

**Match the incident's impact level to the alert severity that triggered it**
(`alert-catalog.md`'s [severity matrix](alert-catalog.md#severity-matrix)): a `critical` alarm
(every synthetic-check and probe alarm feeding this status page is `critical` — see
`status_page.tf`'s header) is at minimum "Partial Outage" on the provider's own impact scale for the
affected component, "Major Outage" if more than one public component is affected at once. Do not
under-state impact to make the page look calmer than the alarm says it is.

## Templates

Copy, fill in the bracketed parts, post. Keep them short — a subscriber reads this on a phone
during an outage, not at their desk.

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

`ai` incidents are the one case where the badge doesn't move itself — say so honestly rather than
implying a probe caught it:

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

Native to the status-page provider, not something this repo builds or operates: a subscriber who
signs up on the public page gets an email automatically whenever an incident is posted, updated, or
resolved, and whenever a component's status changes — the same event that drives the page itself.
There is no separate email step here; posting the incident (above) **is** sending the email. This is
the identical boundary `status_page.tf`'s header and `on-call-rotation.md` already draw for the
paging provider: this repo's job is the signal in, not the delivery mechanics of what goes out —
building bounce/complaint handling, unsubscribe, and CAN-SPAM-compliant headers from scratch would
be reinventing a solved, compliance-heavy problem for no benefit over using the provider that
already solved it.

**What "work" means for this acceptance criterion, concretely**: a test subscription against the
page (any email address) receiving the four template emails above, once each, in the right order,
as a real incident is walked through Investigating → Identified → Monitoring → Resolved. Run this
drill after first standing up the provider account and page, and again any time the provider's
subscriber-notification settings are touched — the same "prove the whole path, not just that the
provider is up" reasoning `alert-catalog.md`'s own
[test-firing drill](alert-catalog.md#test-firing-an-alert) already applies to paging.

## Known gaps

- **No automated `ai` signal.** Repeated here deliberately because it is the one place a reader
  might assume the status page is more automatic than it is. Closing this means building a
  synthetic or health-check surface against the AI path that doesn't itself call Anthropic on every
  probe cycle (a real completion request, run once a minute, would be a meaningful and pointless
  cost) — scoped as future work, not part of this ticket.
- **No incident history export or status page uptime report** beyond whatever the provider's own
  dashboard shows — this repo does not mirror incident history into its own runbooks or database.
