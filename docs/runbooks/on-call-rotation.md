# On-call rotation (ST-262)

Who answers a page, when, and what they are expected to do.

This file is the human contract behind the `critical` / `warning` split.

## Where the rotation actually lives

**Nowhere automated, today.** The alerting pipeline ST-262 built (Prometheus rules, CloudWatch
alarms, Alertmanager routing to SNS email/SMS and Telegram, and the alert catalog that went with
them) ran on AWS and was retired with it. Production on fly.io reports errors to Sentry (org
`studafy-limited`) and ships logs to Axiom (dataset `studafy-logs`, `infra/fly/log-shipper.toml`);
no alert rules, routes or paging integration for either are defined in this repository, and there
is no alert catalog yet.

Until the team adopts an on-call provider, the rotation below is followed by people, not enforced
by a tool. This document is the **specification** that provider will be configured to; when the two
disagree, this file is what the configuration is wrong against.

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

**If you cannot fix it, escalate.** Escalating is the expected outcome for a whole class of alerts (a replica rebuild, a billing reconciliation), not
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

- [ ] You can sign in to Sentry (org `studafy-limited`) and Axiom (dataset `studafy-logs`).
- [ ] You have `fly` CLI access to the `studafy-core-*` apps (`fly status`, `fly logs`) and can run
      the **Production deploy (fly.io)** workflow ([`infra/fly/README.md`](../../infra/fly/README.md)).
- [ ] Once an on-call provider exists: you are in its schedule for the week and your notification
      rules are set for the device you actually sleep next to.

## Handover

Fifteen minutes, Sunday morning, both people present. The outgoing primary walks through:

1. **What fired**, and what was done about it. The provider's incident list is the agenda.
2. **What is still open** — anything degraded, mid-investigation, or waiting on someone else.
3. **Every active silence**, why it exists and when it expires. A silence handed over without an
   explanation is a hidden outage waiting for the week it expires.
4. **Anything scheduled this week** that will look like an incident: a migration, a bulk import, a
   certificate rotation, a load test.

A fortnightly noisy-alert review belongs in the same slot on alternate weeks, with the same two
people, for the same reason: the person who was woken is the one with the evidence.

## Changing the rotation

The AWS-era mechanism (SNS subscriber lists and a Telegram chat set through Terraform variables) is
gone. How people are added to or removed from alert notifications on Sentry/Axiom is not yet
defined; until it is, the roster is this team's own list.
