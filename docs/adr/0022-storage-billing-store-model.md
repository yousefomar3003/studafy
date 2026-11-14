# ADR-022: Storage billing works like an app-store subscription

## Status

Accepted

## Context

The storage add-on is the only thing Studafy sells through Stripe (school licences are paid by bank
transfer or a payment link; students and parents buy AI through the App Store and Google Play). On
2026-11-14 a school owner paid for 100 GB ($10), switched up to 1 TB (a prorated $38.79), switched
back down, and switched up again: the confirmation said nothing would be charged, and the card was
charged $38.62. There was also no way to change the card, and cancelling was a single unlabelled
"Stop renewing" button.

**Cause of "shown 0, then charged".** A move down used Stripe's `create_prorations`: the unused part
of 1 TB stayed on the customer as a pending credit (invoice items waiting for the next invoice), never
returned to the card. The next move up was previewed with `invoices.createPreview`, which counts the
customer's pending invoice items, so the credit netted the preview to about 0. The change itself
(`subscriptions.update` with `always_invoice`) invoiced only that update's own prorations and charged
the card the full $38.62, leaving the credit pending to reduce the next renewal. The preview and the
charge were computed differently, so the amount confirmed was not the amount charged.

## Decision

1. **More storage on the same interval applies now**, with one prorated charge, for exactly the
   amount the school confirmed (`prorationDate` + `expectedAmountMinor`, as before).
2. **Less storage, or the other interval, applies at the next renewal** — as Apple and Google do.
   Nothing is charged or credited now; the school keeps what it pays for until the renewal; Stripe
   holds the change as a subscription schedule (current price to the period end, then the new price,
   no proration) and the add-on row records it (`pending_*`, `stripe_schedule_id`, migration 000222).
   The webhook pipeline applies it when the subscription's price becomes the scheduled one. The
   school can undo it until then. Because no change creates a credit any more, previews and charges
   can no longer disagree.
3. **One change at a time.** No change while one is scheduled, while the add-on has a payment due
   (`past_due`, `grace_period`), or while the customer has pending invoice items (a leftover credit or
   charge a preview would count and an immediate change would not): 409 `STORAGE_ADDON_UNSETTLED`.
4. **What was charged is checked.** After an immediate change, the invoice Stripe created is read
   back. Anything taken beyond the confirmed amount is refunded at once (idempotency key from the
   invoice and the confirmation) and recorded in `app.storage_billing_incidents`; a refund that fails
   is recorded as `needs_review`. Both show on the platform system-health page.
5. **The payer chooses the card for every payment they make**, like a store's payment sheet; only
   automatic renewals charge the renewal card on their own. The change dialog lists the school's
   saved cards (brand, last four, expiry; the renewal card chosen by default) and **Use a new card**
   (Stripe Checkout in setup mode: the card is saved, nothing is charged, and the page returns to the
   same change). The immediate change swaps the price with `create_prorations`, builds an invoice of
   exactly those prorations, finalizes it with `auto_advance: false` (so Stripe makes no attempt of
   its own on the default card), checks its amount against the confirmed one, and pays it with the
   chosen card only. A declined card, or any other amount, voids the invoice and puts the old price
   back: nothing changes, and the school can pick another card. Choosing a card never changes the
   renewal card; **Also use this card for renewals** (unticked by default) does. The card must be one
   of the school's own (422 `STORAGE_ADDON_CARD_INVALID`). Webhooks leave that invoice, and the
   card-saving checkout, alone (`metadata.studafy_purpose`).
6. **Manage subscription** on the school's storage page: plan, renewal or end date, next bill, card,
   **Update card** (Stripe's Billing Portal, limited by a configuration Studafy creates to replacing the
   card and reading invoices — no plan changes or cancellation there, so Stripe and Studafy never
   disagree), **Cancel subscription** / **Resume subscription** (one plain confirmation; cancelling
   drops a scheduled change) and **Billing history** with receipts.
7. **Super admin**: the school's platform page shows the add-on, any scheduled change, its Stripe
   invoices (paid and refunded), its incidents, and a **Refund** action (full or partial, reason
   required, audited, idempotent, never more than is left on the invoice).

## Consequences

- A school moving down or changing interval waits for its renewal to see the change, as on a phone.
- A school with a leftover pending credit from before this change cannot change tier until its next
  renewal consumes it (or the super admin settles it in Stripe); the message says so and nothing is
  charged.
- A card that needs the bank's confirmation (3-D Secure) cannot be charged off-session for a change;
  it is declined with nothing changed, and the school can choose another card.
- Stripe's Billing Portal configuration is created by the API the first time a school opens
  **Update card**; nothing has to be configured in the Stripe dashboard.

## Review

- yousefomar3003, 2026-11-14 (the requirement: storage billing must be as predictable as an App Store
  or Google Play subscription — never charge more than shown, a place to cancel and to change the
  card).
