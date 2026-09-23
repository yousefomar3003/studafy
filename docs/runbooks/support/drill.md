# Support workflow drill

A fixed script that pushes one synthetic ticket per severity through
[`README.md`](README.md)'s intake → triage → resolution path, and confirms the `critical` one
actually pages on-call — the same "run it for real once, don't just read it and assume it works"
posture as [`../security/rotation-drill.md`](../security/rotation-drill.md) and the DR drills under
[`../dr/`](../dr/).

## Status

**This script has never been run.** No support request — synthetic or real — has ever flowed
through this workflow. This file is what to run once the intake channel is provisioned
(`README.md`'s Known gaps), not a report of a run that already happened. Do not read a future
completed run into this document; when it's actually run, record the result in
[Post-drill record](#post-drill-record) below, in this file, committed.

## Pre-flight

- [ ] `support@send.studafy.com` receives mail (the channel is provisioned per
      [`README.md`](README.md#email--exists-in-code-not-provisioned)) — or, if run before that,
      a stand-in inbox the executor controls, noted as such in the record.
- [ ] The on-call primary and secondary for the drill window know a drill page is coming and when
      (same courtesy `../security/rotation-drill.md` extends before rotating a live secret) — this
      is a real page, not a simulated one; `../on-call-rotation.md`'s escalation timers run for
      real if it's not acknowledged.
- [ ] Executor has access to file GitHub issues labelled `support` (the `backlog` disposition's
      destination) and to whatever the current mailbox-reading surface is.
- [ ] [`macro-library.md`](macro-library.md) is open — the `warning`/`info` tickets below are
      designed to match a macro; using one is part of what's under test.

## Run order

Three synthetic tickets, one per severity, sent as real emails to the intake address so the whole
path is exercised — not three descriptions of what should happen.

### 1. `info` ticket — macro path

Send: a ticket matching macro [#1 in the library](macro-library.md#1-invitation-email-never-arrived)
("I sent an invitation and it never arrived"), clearly marked `[DRILL]` in the subject so it's never
mistaken for a real school's request.

Expect: triage finds it inside the mailbox-check cadence, matches macro #1, responds with that
macro's text, dispositions `training`. Time the gap between send and first response against the
`info` SLA (2 working days) — it should clear in minutes during a drill, which is the point: the
SLA is a ceiling, not a target.

Evidence: timestamps (sent, first response), the disposition recorded, confirmation the macro's
text (not a freehanded answer) was what went back.

### 2. `warning` ticket — `backlog` disposition

Send: a ticket describing a real-shaped but non-urgent defect that doesn't match any macro (for
example, "the refund list's `Failed` filter shows results that are actually `Rejected`" —
deliberately outside the library so triage has to file fresh rather than reach for a canned
response).

Expect: triage dispositions `backlog`, files a GitHub issue labelled `support` referencing the
drill ticket, and sends an acknowledgment naming the disposition inside the `warning` SLA (1 working
day).

Evidence: the GitHub issue link, the acknowledgment timestamp and text.

### 3. `critical` ticket — SEV escalation, pages on-call

Send: a ticket that fails the SEV-candidate test in the affirmative — for example, "grades a
teacher published this morning are showing to the wrong students" (reads as cross-tenant-adjacent,
`README.md`'s severity table makes that `critical` unconditionally).

Expect, in order:

1. Triage recognizes it as `critical` inside the 15-minute SLA (not the mailbox-check cadence —
   `critical` doesn't wait for the next scheduled check; this is why out-of-hours coverage matters).
2. Disposition `sev`, which per [`README.md`](README.md#escalation-into-an-incident) leaves this
   workflow and pages per [`../on-call-rotation.md`](../on-call-rotation.md)'s `critical` path —
   confirm the actual page arrives (device buzzes, provider shows it delivered), not just that the
   runbook says it should.
3. On-call primary acknowledges within on-call-rotation.md's 15-minute window.
4. A status-page draft is prepared per
   [`../incident-comms-templates.md`](../incident-comms-templates.md) (drafted only — a drill never
   posts a public-facing incident).
5. Resolve the drill ticket explicitly ("drill — no real incident") and file the follow-up ticket
   the escalation path requires before calling it closed, same as any other incident exit.

Evidence: the page delivery confirmation (provider timestamp or screenshot), the acknowledgment
timestamp, the drafted status-page text (not published), the follow-up ticket link.

## Abort criteria

- The `critical` ticket does not produce an actual page within 5 minutes of the `sev` disposition —
  stop, this is the escalation path failing, not a timing fluke; investigate
  `../on-call-rotation.md`'s provider config before re-running.
- Any drill ticket gets treated as a real school's request downstream (e.g. escalated further than
  this script, or a real customer-facing reply goes out) — abort, and add a clearer `[DRILL]`
  convention before re-running.

## Post-drill record

One entry here per run, oldest first — do not overwrite a prior run's record:

| Date | Executor | `info` first-response time | `warning` disposition + issue link | `critical`: paged? ack time? | Gaps found |
| ---- | -------- | -------------------------- | ---------------------------------- | ---------------------------- | ---------- |
|      |          |                            |                                    |                              |            |

Closing rule, same as `../security/rotation-drill.md`: a run only counts once all three rows in
[Run order](#run-order) have evidence recorded above — a partial run (e.g. `critical` skipped
because on-call wasn't available) is a gap to close, not a completed drill.
