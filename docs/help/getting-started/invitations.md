---
title: "Invitations"
description: "How to invite staff and students, what the invitation states mean, and how to fix invitations that do not arrive or do not work."
keywords: ["invite", "invitation", "resend", "revoke", "bulk invite", "expired", "link", "roles"]
order: 2
---

# Invitations

People join Studafy through invitation links. You manage them from
Admin → Invitations.

## What you can invite

An invitation assigns one role to one person. The invitations page offers
`Admin`, `Teacher`, `Teaching assistant`, `Student`, and `Guest`. The setup
wizard only offers the staff-facing subset (`Admin`, `Teacher`, `Teaching
assistant`).

## Sending a single invitation

1. Open Admin → Invitations → **Invitations** tab.
2. Click `New invitation`.
3. Enter the email, pick a role, and optionally set the expiry in days (1–365).
   Left blank, the school default applies (7 days by default).
4. Send. The recipient gets an email with a personal, single-use link.

After sending, the `Invitation sent` dialog shows the invite link. Use
`Copy link` if the person needs it another way (for example over chat). This
is the same link the email contains — it works once, then becomes `Consumed`.

## Sending bulk invitations

1. Open the **Bulk invites** tab.
2. `New bulk invite`, pick one role for the batch, and paste up to 5,000
   emails. Emails are split on whitespace, commas, and semicolons, de-duplicated
   case-insensitively, and invalid addresses are rejected.
3. The batch shows as `Processing`, then `Completed`. The detail view tracks
   per-recipient dispatch: `Pending`, `Sent`, `Failed`.

Every recipient still receives their own separate invite. To send different
roles, create one batch per role.

## Invitation states

| State      | Meaning                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `Pending`  | Invite sent, not yet used. Can be resent or revoked.                         |
| `Expired`  | Not used before the expiry date. Can be resent, which issues a new link.     |
| `Consumed` | The link was used and an account was created. Nothing to do.                 |
| `Revoked`  | The link was revoked and now fails. Send a new invitation to restore access. |

Bulk batches show `Pending`, `Processing`, `Completed`, or `Failed`.

## Troubleshooting

**The invitation email did not arrive.**

Check they are counted under **Invitations** → `Pending` or the bulk batch
shows `Sent`. If so, the email was dispatched — check spam and trash first.
Otherwise select the invitation and `Resend`, then copy the link from the
dialog and share it directly.

**They say the link "does not work".**

A link works exactly once. If it was already used the invite shows
`Consumed` — the person may already have an account and just needs to sign in.
If the invite shows `Expired` or `Revoked`, `Resend` to issue a fresh link.

**The invite expired before they used it.**

Select the invitation and `Resend`. This sends a new email and replaces the
link.

**We sent an invitation to the wrong person.**

`Revoke` the invitation. The link stops working immediately and this cannot be
undone from this screen. Send a new invitation if the correct person still
needs access.

**Some addresses in a bulk batch show `Failed`.**

Those emails were rejected (invalid address or dispatch failure). Create a new
batch with corrected addresses. The rest of the batch is unaffected.

**A link was resold or leaked.**

Revoke it immediately with `Revoke`. Because a link is single-use, a new
invitation — not the old link — is the only way back in.
