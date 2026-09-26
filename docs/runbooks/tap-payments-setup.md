# Tap Payments setup (ST-298)

Tap bills schools in its MENA markets — subscriptions and online fee payments — through a hosted
payment page: card, mada (SA), KNET (KW), Benefit (BH), and whatever else the merchant account has
enabled for the charge currency. Every other school stays on Stripe. This runbook covers turning Tap
on, proving it in test mode, operating it, and what is still unverified.

## Where the code is

| Piece                                                  | Location                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| Tap HTTP client, amounts, `hashstring`, status mapping | `packages/tap-payments`                                            |
| `PaymentProviderPort` adapter                          | `apps/api/src/modules/subscriptions/tap/adapter.ts`                |
| Charge → shared billing event                          | `apps/api/src/modules/subscriptions/tap/event-normalizer.ts`       |
| Region routing (who bills whom)                        | `apps/api/src/modules/subscriptions/payment-provider-routing.ts`   |
| Webhook processor (shared with Stripe)                 | `apps/api/src/modules/subscriptions/webhooks/webhook-processor.ts` |
| Renewals, retries, period-end cancellation             | `apps/workers/src/queues/billing/tap-renewal.ts` (daily 03:00 UTC) |
| Online fee collection                                  | `apps/api/src/modules/finance/online-payments/`                    |
| Schema                                                 | migrations `000111`–`000113`                                       |

## How it fits together

```
subscription checkout ─┐                           ┌─► Tap hosted page (card data stays at Tap)
online fee payment ────┼─► region = Tap country? ──┤   save_card on subscription checkouts
                       │   (AE BH EG JO KW OM QA SA)└─► redirect to success URL ?tap_id=chg_…
renewal worker (daily) ─► charge the saved card under its payment agreement (no payer present)

Tap ─► POST /api/subscriptions/webhook/tap  (hashstring header)
         ├─ verify HMAC-SHA256(secret key) over the signed charge fields
         ├─ GET /v2/charges/{id}   metadata/customer are unsigned: the re-read is the truth
         ├─ normalize to the Stripe event vocabulary
         ├─ metadata.purpose = fee_payment ─► settle the fee payment ─► ERPNext Payment Entry
         └─ otherwise ─► @studafy/billing (ledger claim, state machine, audit) — same as Stripe
```

Routing is by `app.schools.country_id`. There is no fallback: a Tap-country school on a deployment
without Tap credentials gets `503 TAP_NOT_CONFIGURED`, never a Stripe checkout.

### Subscription lifecycle on Tap

| Moment             | What happens                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Checkout paid      | `checkout.session.completed` → `active`; saved card stored on the subscription; period = charge time + one `billing_interval` |
| Checkout declined  | `checkout.session.expired` → recorded, no state change; the school retries checkout                                           |
| Period ends        | The renewal worker charges the saved card for the next period (`subscription_cycle`)                                          |
| Renewal paid       | `invoice.paid` → period advanced to the one charged for                                                                       |
| Renewal declined   | `invoice.payment_failed` → `past_due`; retried every 3 days, 3 attempts per period                                            |
| Last attempt fails | The worker applies `dunning_exhausted` → `grace_period`; the existing dunning sweep reminds and closes                        |
| Cancel scheduled   | `cancel_at_period_end`; at period end the worker applies `canceled` instead of charging                                       |
| School suspended   | AI add-ons move to `paused` locally; the worker never charges a paused subscription                                           |

Renewal attempts are claimed in `app.tap_renewal_attempts` and committed **before** the charge is
sent. If the worker cannot tell whether Tap charged (timeout, crash, 5xx), the attempt is marked
`unknown` and that period is **blocked** until a human reconciles it — see Operating.

### Online fee payment

A parent linked to the student (or staff with `billing:update`) calls
`POST /api/finance/online-payments` with the invoice from the family view's `pay_online_url`. The
amount is the invoice's outstanding balance from `app.invoice_cache`, never the request. One payment
per invoice may be in flight for 30 minutes. The webhook settles it: a captured payment whose amount
and currency match is recorded in ERPNext through the payment forwarder (idempotency key
`online-fee-<payment id>`), then marked `succeeded`. Poll `GET /api/finance/online-payments/{id}`.
The same flow runs on Stripe (Checkout `payment` mode) for non-Tap schools.

## 1. Configure

| Variable          | Where        | Value                                                                    |
| ----------------- | ------------ | ------------------------------------------------------------------------ |
| `TAP_SECRET_KEY`  | api, workers | `sk_test_…` (staging) / `sk_live_…` (production), from the Tap dashboard |
| `TAP_WEBHOOK_URL` | api, workers | Public URL of `POST /api/subscriptions/webhook/tap`                      |

- Both or neither: `apps/api/src/env.ts` refuses one without the other; the worker skips renewals
  when the key is absent and fails the job when the key is present without the URL.
- Tap has no separate webhook secret: **the secret key is also the webhook HMAC key**. Rotating it
  changes verification at the same instant; rotate it like the Stripe secret key in
  [`security/rotation-provider-api-keys.md`](security/rotation-provider-api-keys.md), and expect
  webhooks for charges in flight to fail verification until Tap retries.
- The webhook URL is sent on every charge (`post.url`); nothing is registered in the dashboard.

**Deployment wiring.** Both variables are injected from each service's Secrets Manager
app-secrets (`infra/deploy/ecs/{api,workers}/task-definition.json.tpl`). ECS refuses to start a task
whose `valueFrom` names a JSON key the secret does not hold, so Terraform always writes both keys:
`module.secrets`' `app_secret_defaults` defaults them to `""` for `api` and `workers`, and the apps
read `""` as "Tap off". To turn Tap on in an environment, supply real values through
`TF_VAR_secrets_app_secret_values` (as `infra/deploy/scripts/rotate-app-secret.sh` does) and roll
both services.

**Order on the first deploy of this change:** `terraform apply` (so both secrets contain the keys)
**before** deploying the new api and workers task definitions. Deploying the task definitions
first would fail to start the tasks until the apply lands.

Apply migrations `000111`, `000112`, `000113`.

## 2. Enable payment methods and recurring on the Tap account

- Per currency: mada needs SAR, KNET needs KWD, Benefit needs BHD; cards work across currencies
  including JOD. `src_all` shows whatever is enabled for the charge currency.
- **Ask Tap to enable saved cards and merchant-initiated (recurring) charges.** Without it the first
  checkout still works but carries no card or agreement, the subscription never gets a saved card,
  and the renewal worker skips it (it only renews subscriptions with `tap_card_id`).
- A school is charged in its `default_currency_id`; its plan needs an active `app.plan_prices` row
  in that currency.

## 3. Prove it in test mode

1. **Sandbox smoke test** — customer plus hosted JOD charge:

   ```bash
   cd apps/api && TAP_TEST_SECRET_KEY=sk_test_... bun test tap-sandbox
   ```

2. **Subscription, end to end in staging** (`TAP_SECRET_KEY=sk_test_…`):
   1. A school whose country is JO, with a JOD plan price. `POST /api/subscriptions/school/checkout`;
      open the `url`; pay with a Tap test card from Tap's sandbox docs (never put card numbers in
      code, tickets or logs).
   2. Check: `app.schools.tap_customer_id` set; an `app.billing_events` row with `provider = 'tap'`,
      `chg_…:CAPTURED`, `checkout.session.completed`, `processed`; `app.subscriptions` is `active`
      with `tap_card_id`, `tap_payment_agreement_id` and a one-month period; an `app.audit_logs`
      row.
   3. Redeliver the webhook: `{"outcome":"duplicate"}`, no new row.
   4. Renewal: set that subscription's `current_period_end` to the past and run the job once
      (`run-tap-renewals` on the billing queue). Check a `succeeded` row in
      `app.tap_renewal_attempts`, then an `invoice.paid` event and the period advanced a month.
   5. Decline: repeat with a test card Tap declines — `past_due`, and a retry three days later.

3. **Fee payment** (staging): take an outstanding invoice's `pay_online_url` from the family view,
   `POST /api/finance/online-payments` as the linked parent, pay on the returned page, and check the
   payment reaches `succeeded` with an `erpnext_payment_entry_id` that exists in ERPNext.

## 4. Operating it

| Symptom                                                                  | Meaning                                                                                      | Action                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tap_webhook_signature_invalid` in `app.security_events`                 | Hash mismatch or missing `hashstring`                                                        | After a key rotation: `TAP_SECRET_KEY` is out of sync with the account. Otherwise a probe.                                                                                                                                       |
| Webhook answers `503 TAP_API_ERROR`                                      | The re-read of the charge from Tap failed                                                    | Tap outage; Tap redelivers. No alert — the delivery may be genuine.                                                                                                                                                              |
| `app.tap_renewal_attempts.status = 'unknown'`                            | The worker could not tell whether Tap charged                                                | Find the charge in the Tap dashboard (the attempt id is its `reference.order`). Charged: set the attempt `succeeded` with its `tap_charge_id` and check the webhook applied. Not charged: set it `failed`; the next run retries. |
| Log "tap renewal blocked: cannot price the renewal"                      | No paid Tap charge records `price_id`, or that price is gone                                 | Fix the price; the next run charges.                                                                                                                                                                                             |
| Online payment stays `pending` after the payer paid                      | Webhook not delivered, or ERPNext refused/was down (the webhook answers 500 and Tap retries) | Check API logs for the payment id; ERPNext errors surface there.                                                                                                                                                                 |
| Log "fee payment event could not be settled; parked"                     | Amount/currency mismatch, or an event that does not match the payment                        | Money may have moved: reconcile against Tap and ERPNext by hand; refund if needed.                                                                                                                                               |
| `billing_events.status = 'dlq'`, "Could not attribute … tap customer id" | The charge's customer is no school's `tap_customer_id` and metadata names no school          | Inspect `payload`; fix the mapping; replay.                                                                                                                                                                                      |
| `event_type` like `tap.charge.unknown`, parked                           | A Tap status nothing maps                                                                    | Decide its meaning in `packages/tap-payments/src/charge-status.ts`; replay.                                                                                                                                                      |

## Limits as built

- **Billing portal**: Tap has none; `POST /api/subscriptions/portal` stays Stripe-only. A Tap
  school replaces an expired card by paying again after `past_due` (a new checkout saves the card).
- **Product/price sync** is Stripe-only; Tap charges the `app.plan_prices` amount directly.
- **Invoices** for a Tap school are its Tap charges (`POST /v2/charges/list`); Tap issues no invoice
  PDF or hosted invoice.
- **Seat changes mid-period** are not prorated on Tap; each renewal bills the enrolled count at that
  moment. Stripe schools keep the nightly seat reconciliation.
- **Refunds** of online fee payments go through the existing ERPNext refund flow; nothing here calls
  Tap's refund API.

## Unverified against a live Tap account

Built from Tap's public API documentation and covered by tests against a fake Tap. No Tap key was
available during development, so confirm these in step 3 before go-live:

- The `hashstring` field order and amount formatting (`toFixed` at the currency's decimals, no
  thousands separator). If genuine deliveries raise `tap_webhook_signature_invalid`, look at
  `packages/tap-payments/src/signature.ts` first.
- Recurring: charges carry `card.id` and `payment_agreement.id` after `save_card`; `POST /v2/tokens`
  with `saved_card` mints a token; a charge with `customer_initiated: false` and
  `payment_agreement.id` is accepted with no payer present.
- `POST /v2/charges/list` accepts `customers`, `limit` and `starting_after` and answers
  `{ charges, has_more }`.
- Free-form `metadata` keys round-trip unchanged; `transaction.created` is epoch milliseconds;
  `live_mode` is present.
- Tap accepts a customer with `first_name` only (schools are created without an email).
- `TAP_COUNTRY_CODES` matches the markets the merchant account can acquire in.
