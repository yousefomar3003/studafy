# Stripe modes: running production on Sandbox, and going live

Only the school **storage add-on** is paid through Stripe (licences are paid by bank transfer or a
Revolut link; students and parents buy AI in the app stores). While the product is being tested,
production runs on **Stripe Sandbox** keys: test cards only, no real money. When it is time to sell,
the keys are switched to **live**.

The mode is never configured separately: it is read from the key's prefix (`sk_live_`/`rk_live_` =
live, `sk_test_`/`rk_test_` = Sandbox, `stripeModeFromKey` in `@studafy/billing`). Everything below
follows from the key in the `prod` GitHub environment.

## What Studafy does in each mode

- **Visible mode.** The school's Storage page shows _"Test mode: no real money"_ with the test card
  to use while the key is a Sandbox key. The super admin **Health** page shows _Stripe: Sandbox_ or
  _Stripe: Live_.
- **Webhooks from the other mode are ignored.** A Sandbox event never moves state while the key is
  live, nor a live event while it is Sandbox. Such an event is answered `200` (outcome `ignored`, so
  Stripe stops redelivering it) and logged as `stripe event from the other account mode ignored`.
  The two modes also sign with different webhook secrets, so this is the second lock.
- **One Stripe customer per school and mode.** `app.schools.stripe_customer_livemode` records which
  mode `stripe_customer_id` belongs to (000225). A customer from the other mode is replaced by this
  mode's at the school's next checkout. Before creating a customer Studafy reuses the one Stripe
  already holds for the school (`metadata.school_id`), and the create carries an idempotency key per
  school and mode, so a failed checkout no longer leaves an orphan customer behind.
- **A storage add-on bought in the other mode** (`app.storage_subscriptions.stripe_livemode`) is
  ended for this mode the next time the school's storage page or a storage action runs: the row is
  marked `canceled` (audited as `stripe_mode_switched`), the school is back on its included 10 GB,
  and **no file is deleted**. It never blocks a purchase and is never changed or cancelled through
  the wrong key. **The subscription itself is not cancelled at Stripe** -- the key in use cannot see
  it. Cancel it in that mode's dashboard (see the checklists).
- **Prices** are republished into the current mode by the super admin's price sync: a stored
  `stripe_price_id` the key cannot see is replaced.

## Switching production to Sandbox

1. **Stripe dashboard (live):** cancel every live storage subscription you do not want to keep
   billing (Customers → the school → the subscription → _Cancel subscription_). Then disable the live
   webhook endpoint (Developers → Webhooks → the `api.studafy.com` endpoint → _Disable_), so Stripe
   does not keep retrying deliveries that the Sandbox secret cannot verify.
2. **Stripe dashboard → account menu → Sandboxes → Create a sandbox** (for example "Studafy testing").
   Open it.
3. **Developers → API keys:** copy the **Secret key** (`sk_test_…`).
4. **Developers → Webhooks → Add endpoint:**
   - Endpoint URL: `https://api.studafy.com/api/subscriptions/webhook/stripe`
   - Events to send:
     - `checkout.session.completed`
     - `checkout.session.expired`
     - `checkout.session.async_payment_succeeded`
     - `checkout.session.async_payment_failed`
     - `customer.created`
     - `customer.updated`
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `customer.subscription.paused`
     - `customer.subscription.resumed`
     - `invoice.paid`
     - `invoice.payment_succeeded`
     - `invoice.payment_failed`
     - `invoice.marked_uncollectible`
   - Save, then copy the endpoint's **Signing secret** (`whsec_…`).
5. **Settings → Billing → Customer portal** in the Sandbox: turn on _payment method updates_ and
   _invoice history_ (the storage page's **Update card** uses it); leave plan changes and
   cancellation off.
6. **GitHub → the repository → Settings → Environments → `prod` → Environment secrets:** set
   `STRIPE_SECRET_KEY` to the `sk_test_…` key and `STRIPE_WEBHOOK_SECRET` to the `whsec_…` secret.
   Keep the live values somewhere safe (a password manager) for going live.
7. **Deploy production** (`gh workflow run fly-production-deploy.yml --ref dev`). The deploy copies the
   secrets to the API and workers.
8. **Super admin → Plans & pricing → Sync with Stripe**, so every price exists in the Sandbox.
9. **Check:** Health shows _Stripe: Sandbox_; a school's Storage page shows the test-mode banner.
   Buy storage with card `4242 4242 4242 4242`, any future expiry, any CVC.

## Going live

1. **Sandbox dashboard:** cancel the Sandbox storage subscriptions (optional -- no money moves) and
   disable the Sandbox webhook endpoint.
2. **Live dashboard:** re-enable the live webhook endpoint (or add it with the event list above) and
   copy its signing secret. Check the live Customer portal settings as in step 5.
3. **GitHub `prod` secrets:** `STRIPE_SECRET_KEY` = `sk_live_…`, `STRIPE_WEBHOOK_SECRET` = the live
   `whsec_…`.
4. **Deploy production**, then **Sync with Stripe** again.
5. **Check:** Health shows _Stripe: Live_; the test-mode banner is gone. Sandbox storage rows end
   for the live mode the first time each school opens its storage page; schools buy again with real
   cards. Schools keep their live customer: it is found again by `metadata.school_id`.

## Before switching: what to clear

- A **pending duplicate** on the Health page (`storage_duplicate_subscriptions`) from the outgoing
  mode cannot be cancelled or refunded with the incoming key and will end up _needs review_. Resolve
  it before switching.
- **Real paying schools on live Stripe:** switching to Sandbox ends their storage add-on in Studafy
  while Stripe keeps billing them. Only switch to Sandbox while no real school pays through Stripe.
