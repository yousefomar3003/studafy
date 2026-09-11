# On-call rotation (ST-262)

Who answers a page, when, and what they are expected to do.

The alerts themselves, their severities and their per-alert procedures are in
[`alert-catalog.md`](alert-catalog.md). This file is the other half: the human contract behind the
`critical` / `warning` split that Alertmanager routes on.

## Where the rotation actually lives

**In the on-call provider, not in this repo.** `infra/docker/alertmanager/alertmanager.yml` maps
severity to one of three webhook URLs and stops there; the schedule, the escalation timers and the
notification rules are configured behind those URLs.

That boundary is deliberate and it is also forced. Alertmanager's time intervals _mute_ a matched
route, they do not divert it — its own reference is explicit that a muted route "acts normally
(including ending the route-matching process)". So "page during working hours, raise a ticket
otherwise" cannot be written as two sibling routes: the out-of-hours alert would match the first
one and be silently dropped, never reaching the second. Encoding working hours here would mean
shipping a rule that does not do what it reads as, or duplicating the provider's schedule in a
second place that drifts from it.

So this document is the **specification** the provider is configured to. When the two disagree, this
file is what the configuration is wrong against — and fixing the drift is an agenda item for the
review in [`alert-catalog.md`](alert-catalog.md#the-noisy-alert-review).

## The rotation

|                    |                                                                              |
| ------------------ | ---------------------------------------------------------------------------- |
| **Shape**          | One primary, one secondary, at all times                                     |
| **Cadence**        | Weekly                                                                       |
| **Handover**       | Sunday 10:00 `Asia/Amman` — the start of the working week, not the end of it |
| **Working hours**  | Sunday–Thursday, 09:00–17:00 `Asia/Amman`                                    |
| **Minimum roster** | Four people. Below that, a week of leave leaves no secondary.                |

`Asia/Amman` throughout, deliberately: it is the timezone the product's schools operate in and the
one `app.user_notification_settings.timezone` already defaults to. A rotation defined in UTC drifts
against the working week it is supposed to track twice a year.

**Handover at the start of the week, not the end**, because the outgoing primary is the only person
who can explain what is still open — and the Sunday slot puts that conversation in working hours
instead of at 17:00 on a Thursday when both people want to leave.

## What each severity promises

| Severity   | Primary                             | Secondary                            | Out of hours                |
| ---------- | ----------------------------------- | ------------------------------------ | --------------------------- |
| `critical` | Acknowledge within 15 min, any hour | Paged if unacknowledged after 15 min | **Yes — this wakes people** |
| `warning`  | Triage next working day             | Not paged                            | Queued; nobody is woken     |
| `info`     | Never notified                      | Never notified                       | —                           |

**Escalation for an unacknowledged `critical`:**

```
t+0     page primary
t+15m   page secondary (primary has not acknowledged)
t+30m   page engineering lead
```

Acknowledging is not the same as fixing. Acknowledge as soon as you are looking at it — that is what
stops the escalation and tells everyone else the alert has an owner.

**If you cannot fix it, escalate.** The per-alert sections in
[`alert-catalog.md`](alert-catalog.md) each end with an escalation line saying when. Escalating is
the expected outcome for a whole class of alerts (a replica rebuild, a billing reconciliation), not
an admission of anything.

## Being on call

**You are expected to:** be reachable and able to reach a laptop within 15 minutes during your week;
acknowledge `critical` pages within 15 minutes; and either resolve, escalate, or explicitly silence
with a reason and an expiry — never leave a page unanswered because it looked like noise. If it is
noise, that is a finding for the review, and the silence is how you record it.

**You are not expected to:** fix anything you do not understand at 3am (escalate), work your normal
day after a night that cost you sleep (say so, hand over), or answer `warning`s outside working
hours (they do not page, by design — if one wakes you, the routing is wrong and that is itself a
`critical`).

**Before your week starts**, confirm you can actually do the job — this takes five minutes and is the
difference between an incident and an incident plus an access problem:

- [ ] You can SSH to the bastion and port-forward Prometheus, Alertmanager and Grafana
      ([`alert-catalog.md`](alert-catalog.md#getting-to-prometheus-and-alertmanager)).
- [ ] You have AWS console and CLI access to the environment, including `aws ecs`, `aws logs` and
      `aws cloudwatch set-alarm-state`.
- [ ] You are in the provider's schedule for the week and your notification rules are set for the
      device you actually sleep next to.
- [ ] You have run the `warning`-severity half of the
      [test-fire drill](alert-catalog.md#test-firing-an-alert) and seen it arrive.

## Handover

Fifteen minutes, Sunday morning, both people present. The outgoing primary walks through:

1. **What fired**, and what was done about it. The provider's incident list is the agenda.
2. **What is still open** — anything degraded, mid-investigation, or waiting on someone else.
3. **Every active silence**, why it exists and when it expires. A silence handed over without an
   explanation is a hidden outage waiting for the week it expires.
4. **Anything scheduled this week** that will look like an incident: a migration, a bulk import, a
   certificate rotation, a load test.

The fortnightly [noisy-alert review](alert-catalog.md#the-noisy-alert-review) runs in the same slot
on alternate weeks, with the same two people, for the same reason: the person who was woken is the
one with the evidence.

## Changing the rotation

Adding or removing a person is a change in the provider _and_ a line in this file's roster
expectations if the shape changes. Rotating the receiver URLs means updating
`ALERTMANAGER_PAGE_URL` / `ALERTMANAGER_TICKET_URL` / `ALERTMANAGER_HEARTBEAT_URL` in the
`monitoring` app-secrets container (`TF_VAR_secrets_app_secret_values`, see
[`secrets-conventions.md`](secrets-conventions.md)) and replacing the Alertmanager task so it
re-reads them — then re-running the [test-fire drill](alert-catalog.md#test-firing-an-alert) for
every severity, because a rotated URL that was pasted wrong fails silently and looks exactly like a
quiet week.
