# Macro library

Canned first-response text for the top 10 support issues [`README.md`](README.md#triage) predicts a
live school will hit most, ranked by how likely and how self-service-able each one is. Every macro
does three things and no more: names the state the reader is actually in, links the one
`docs/help/` article that already explains it, and says what to do only when the article doesn't
already say it — the workflow's own rule is that a macro is a shortcut into existing documentation,
not a second copy of it.

**How this list was built** — from what already exists, not from guesswork: the invitation and
payment states below are the literal state machines `docs/help/getting-started/invitations.md` and
`docs/help/billing/subscriptions.md` / `docs/help/finance/workflows.md` document, plus two states
(CSV import, timetable conflicts) that those same articles' own troubleshooting sections already
call out as the ones people get stuck on. See `README.md`'s Known gaps: this is a prediction, not
ticket history — re-rank once real tickets exist.

Each macro's **Disposition** is the default; triage still applies the "SEV candidate" test from
`README.md`'s severity table before using it as-is — a macro never overrides that judgment call.

---

## 1. Invitation email never arrived

**Disposition:** `training` (self-service) — escalate to `backlog` only if resend also fails to
deliver.

> Check Admin → Invitations — if the invite shows `Pending` (or the bulk batch shows `Sent`), the
> email was dispatched; please check spam/trash first. If it's still not there, select the
> invitation and `Resend`, then use `Copy link` to share it directly instead of waiting on email.
> Full steps: [`docs/help/getting-started/invitations.md`](../../help/getting-started/invitations.md#troubleshooting).

## 2. Invitation link "doesn't work"

**Disposition:** `training`.

> A link works exactly once. If the invitation shows `Consumed`, an account already exists — the
> person should just sign in. If it shows `Expired` or `Revoked`, `Resend` issues a fresh link; the
> old one stays dead by design.
> Full steps: [`docs/help/getting-started/invitations.md`](../../help/getting-started/invitations.md#invitation-states).

## 3. Bulk invite batch has `Failed` rows

**Disposition:** `training`, unless the failure rate is high enough to suggest a dispatch-side
defect (then `backlog` — attach the batch ID).

> `Failed` rows are rejected addresses (invalid, or dispatch failure) — the rest of the batch is
> unaffected. Create a new batch with the corrected addresses for just those rows.
> Full steps: [`docs/help/getting-started/invitations.md`](../../help/getting-started/invitations.md#troubleshooting).

## 4. Subscription shows `Past due` or `Grace period`

**Disposition:** `training` — this is expected product behavior, not a defect. Promote to `sev`
only if the payment method is confirmed valid and the state doesn't clear after a retry (that's a
webhook or reconciliation defect, not a billing question).

> `Past due` means the last payment failed; `Grace period` is the window before the subscription
> closes automatically. Use `Update payment method` on the Billing page — this opens the payment
> provider's own portal (Studafy never stores card details).
> Full steps: [`docs/help/billing/subscriptions.md`](../../help/billing/subscriptions.md#subscription-states).

## 5. "My card was declined / payment method won't update"

**Disposition:** `training` first response (send to the provider portal); `backlog` if the provider
portal itself errors rather than the card being rejected.

> Card details are managed entirely in the payment provider's portal
> (`Payment and invoices` → `Manage payment method`) — a decline is between the reader and their
> card issuer, not something Studafy can retry on their behalf. If the portal itself won't open or
> errors, that's ours to fix — file `backlog`.
> Full steps: [`docs/help/billing/subscriptions.md`](../../help/billing/subscriptions.md#managing-the-payment-method).

## 6. Tuition payment stuck on `Pending`

**Disposition:** `training` first response; `backlog` if still `Pending` after a working day (ERPNext
confirmation is background but not indefinite).

> Payments confirm with ERPNext in the background — `Pending` is the normal in-flight state, and the
> receipt link appears once confirmed. Payments are idempotent, so resubmitting cannot create a
> duplicate; if a submission was already recorded, check the payment history before retrying.
> Full steps: [`docs/help/finance/workflows.md`](../../help/finance/workflows.md#3-record-payments).

## 7. Refund request stuck, `Rejected`, or `Failed`

**Disposition:** `training` if it's sitting in `Pending approval` (needs a second approver, working
as designed); `backlog` if it reached `Rejected`/`Failed` without an approver ever actioning it.

> A refund needs a different user with refund approval rights to approve it before ERPNext issues
> the credit note — check whether anyone with that role has seen the request yet. Track it through
> `Approved` → `Submitted to ERPNext` → `Completed`, or the failure states `Rejected`/`Failed` on the
> refunds list.
> Full steps: [`docs/help/finance/workflows.md`](../../help/finance/workflows.md#request-a-refund).

## 8. Scholarship/discount award not applying to invoices

**Disposition:** `training`.

> An award takes effect only after a **different** user confirms it — the creator cannot also
> confirm, by design. Check whether the award is still `Pending confirmation`.
> Full steps: [`docs/help/finance/workflows.md`](../../help/finance/workflows.md#award-a-scholarship-or-discount).

## 9. Student/staff CSV import rejected during onboarding

**Disposition:** `training` first response; `backlog` if the error report itself is wrong or
unreadable rather than the data being invalid.

> The error report lists the exact line, field, and problem for every rejected row — fix those rows
> and re-upload. Valid rows in the same file are unaffected; only the flagged rows are skipped.
> Full steps: [`docs/help/getting-started/onboarding-guide.md`](../../help/getting-started/onboarding-guide.md#troubleshooting).

## 10. Timetable won't approve — "conflict" blocking it

**Disposition:** `training`.

> The builder blocks approval while a placement conflicts with another class, room, or teacher in
> the same period — the conflicts panel names which one. Resolve the listed conflict (move the
> period, room, or teacher) rather than forcing approval; there's no override.
> Full steps: [`docs/help/academics/timetable.md`](../../help/academics/timetable.md#conflicts).

---

## Using a macro

1. Confirm the reader's actual state matches the macro (screenshot or the exact status pill/label
   they see) before pasting the response — a macro answers the state named, not a guess at it.
2. Paste the response, link included, and set the disposition named above unless the SEV-candidate
   test in [`README.md`](README.md#severity-and-response-time-sla) says otherwise.
3. If the same reader comes back after following the macro and it didn't resolve things, that's a
   `backlog` issue at minimum — a macro that doesn't hold up under a real case is itself a finding,
   not just a closed ticket.

## Keeping this list current

Ten is a floor, not a ceiling, and a starting guess, not a measured list — see `README.md`'s Known
gaps. When a real ticket doesn't match any macro above, that's the signal to add one, not to keep
answering it from scratch every time. When `docs/help/` gains a new article with its own
troubleshooting section, add a macro pointing at it rather than waiting for a ticket to force the
issue.
