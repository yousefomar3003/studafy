# Secret rotation: webhook secrets

The shared-secret material both sides of an inbound webhook verify against: Stripe
(`STRIPE_WEBHOOK_SECRET`, verified by `StripeAdapter.constructEvent`), Resend
(`RESEND_WEBHOOK_SECRET`, the svix-style signature verified at `/email/webhooks/resend` by
`apps/api/src/email/webhook.ts`) and ERPNext (`ERPNEXT_WEBHOOK_SECRET`, HMAC-SHA256 verified in
`apps/api/src/erpnext/webhook.ts`).

What makes this class different: **the same secret exists on the sender's side too.** Rotating the
value in the `prod` GitHub Environment without updating the sender makes every delivered event a signature
mismatch — an incident that looks exactly like a misbehaving provider. Both sides move before
verification is re-proven.

## Procedure

Every rotation is: **obtain/set on the sender → set in the `prod` environment → run the deploy workflow → prove a real
delivery verifies → revoke old on sender.**

### Stripe webhook

1. In the Stripe dashboard webhook settings, add a new signing secret for the webhook endpoint
   (Stripe supports regenerating the secret with an overlap period: the endpoint keeps accepting
   both old and new for a window it controls).
2. Set the new value as `STRIPE_WEBHOOK_SECRET` in the `prod` environment and run **Production
   deploy (fly.io)**, which stages it onto the api and redeploys it.

   `apps/api/src/env.ts` pairs `STRIPE_WEBHOOK_SECRET` with `STRIPE_SECRET_KEY` (both present or
   both absent), so keep the two consistent — see
   [`rotation-provider-api-keys.md`](rotation-provider-api-keys.md)'s Stripe step.

3. **Prove verification, don't assume it.** Trigger a real low-risk Stripe event
   (a `customer.created` or a webhook test send from the dashboard). Success = the webhook route
   answers the signature check and the delivery log shows 200.
4. After the overlap window, disable the old signing secret in the dashboard.

Failure shape to distinguish: `stripe_webhook_signature_invalid` rows in `app.security_events`
(the sink at `apps/api/src/lib/security/securityEventSink.ts`) mean the new secret doesn't match
what Stripe is sending — either the sender-side regenerate never applied, or the two rotated out of
step. This is the alert to check before touching anything else.

### Resend webhook

`RESEND_WEBHOOK_SECRET` is the signing secret of the Resend webhook that posts delivery events to
`https://api.studafy.com/email/webhooks/resend`. A missing secret answers 500; a bad signature
answers 401 and logs `Resend signature verification failed`.

1. Obtain the new signing secret for the webhook in the Resend dashboard.
2. Set it as `RESEND_WEBHOOK_SECRET` in the `prod` environment and run the deploy workflow.
3. Prove a real delivery: send one email (or a test event from the dashboard) and confirm the
   webhook delivery answered 200, with no `Resend signature verification failed` line in the api's
   logs.

Resend has no overlap window known to this repo: events sent between the sender-side change and the
end of the deploy fail verification. Keep that window short.

### ERPNext webhook

There is no ERPNext deployment on fly, and `ERPNEXT_WEBHOOK_SECRET` is not in the deploy
workflow's secret list; this procedure applies once both exist.

`ERPNEXT_WEBHOOK_SECRET` is the HMAC secret `apps/api/src/erpnext/webhook.ts` verifies against the
payload's signature.

1. Set the new secret in the ERPNext webhook configuration (the site's webhook settings page or
   `erpnext` webhook document) — same value the app will hold.
2. Set the value in the `prod` environment and run the deploy workflow.

3. Prove a real delivery: push a benign ERPNext event from the site (e.g. a test webhook) and
   confirm the route answers as verified, not `signature mismatch` (after a shared-secret rotation,
   a burst of rejections is usually exactly that).
4. Repeat the whole drill for old-value revocation on the sender if the sender supports it;
   otherwise the new value replacing the old in step 1 _is_ the revocation.

## Zero-downtime note, honestly

A webhook secret rotation is not zero-risk by design: if sender and receiver are rotated in the
wrong order there is a window where real events are rejected (Stripe retries with backoff;
ERPNext generally does not). The zero-downtime claim for this class is the **overlap**: set the new
secret on the sender first (Stripe's native overlap, ERPNext's replace-in-place), then roll the app
with the new value. Never the reverse order — revoking a secret the app still holds is an
incident, not a rotation step.

## Audit

Record the evidence per [`rotation-schedule.md`](rotation-schedule.md)'s audit section: the
deploy run that released the new value, the proving event's 200, and (if any fired) the
`*_signature_invalid` rows counted during the overlap.
