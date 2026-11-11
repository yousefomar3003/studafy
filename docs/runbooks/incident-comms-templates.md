# Incident comms templates (ST-264)

What to tell schools and users during an incident, and when, for the five components users see:
`api`, `web`, `realtime`, `ai`, `billing`. Who is doing it: [`on-call-rotation.md`](on-call-rotation.md).

## Status

**There is no public status page today.** ST-264's self-hosted page (S3 + CloudFront, Lambda
functions for incidents and subscriber email through SES, synthetic checks flipping component
badges) ran on AWS and was retired with it. Nothing replaces it yet, so nothing flips a component's
state automatically and there is no subscriber list to email. Where incident updates are published
until a replacement exists is not yet defined; the templates and the four-state sequence below
still apply to whatever channel is used.

**AI outages are not visible from the API's own health.** `/api/ai/health` answering 200 means
`AI_LLM_ENABLED` is on and the process is up; it does not call the model provider. Detect a
provider outage the way [`ai-provider-outage.md`](ai-provider-outage.md) describes, then post the
incident yourself.

## Posting an update

Four states, in order, one incident:

1. **Investigating** — post the moment you're confident this is real (not a flapping check, not a
   drill). Say what's affected, not
   why; you don't know why yet.
2. **Identified** — once you know the cause, even provisionally. This is the update that turns "we
   know something's wrong" into "we know what's wrong", which is the update subscribers are
   actually waiting for.
3. **Monitoring** — once a fix is applied and the component is recovering. Say what you did and how
   long you'll watch before calling it resolved.
4. **Resolved** — once the watch period is over and nothing recurred. Close the loop with a one-line
   summary; save the postmortem for wherever this repo's incident retro process lives, not the
   public page.

**State the impact honestly**: `major` for a single affected component, `critical` if more than one
is affected at once. Do not under-state impact to make the update look calmer than it is.

## Templates

Copy the text and fill in the bracketed parts. Keep them short — a subscriber reads this on a phone during an outage, not at their desk.

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

No automated check sees a live model-provider outage (see "Status" above) — say so honestly rather
than implying one caught it:

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

## Known gaps

- **No public status page and no subscriber emails** since AWS was retired (see "Status").
- **No synthetic check exercises the real AI provider path** — closing this means a surface that
  exercises it without making a real (costly) completion request every minute.
