# ADR-013: Payment abstraction — a port, one adapter, provider-neutral webhooks

## Status

Accepted

## Context

Studafy bills schools (subscriptions) and students (AI entitlements) through a payment provider —
today, Stripe. The billing domain is real business logic: checkout, webhook processing, the
subscription state machine, school suspension, cancellation, price sync. It must be testable
without network access, and the domain itself (`packages/billing`) must not know the difference
between Stripe and a stretched network glitch. Before this decision, Stripe SDK calls and billing
logic lived together, which made unit tests depend on stubbing the SDK and made adding a second
provider a rewrite rather than an addition.

## Decision

- **Port: `PaymentProviderPort`** (`apps/api/src/modules/subscriptions/ports/payment-provider.ts`).
  A plain TypeScript interface with provider-neutral I/O: create/manage customer, checkout session,
  billing portal, product/price sync, `parseWebhook`, invoice listing, and the pause / resume /
  (schedule|reverse)-cancellation controls the state machine needs. Ports are injected at the
  composition root (`apps/api/src/app.ts`), so no route talks to Stripe directly.
- **One adapter: `StripeAdapter`** (`.../stripe/adapter.ts`) implements the port over the Stripe
  SDK. The adapter is the only file that imports Stripe. There is no second production adapter; a
  future PSP means a new adapter implementing the same port and passing the same contract tests, not
  a domain change.
- **A fake for tests.** `FakeStripeProvider` (`apps/api/tests/mocks/fake-stripe-provider.ts`) is an
  in-memory `PaymentProviderPort` used for E2E tests, and **one contract test suite**
  (`.../__tests__/payment-provider-contract.test.ts`) runs the same assertions against every
  implementation — currently the fake and the real adapter — so the fake cannot silently drift from
  the contract the production code relies on.
- **Webhooks are normalized before they reach the domain, and verified by the adapter.**
  `parseWebhook(rawPayload, signature)` is part of the port: the adapter verifies the signature and
  returns a `ParsedWebhookEvent` with exactly the fields the domain may trust — `id` (the _event's_
  identity, used as the idempotency key on `app.billing_events`), `type`, `effectiveAt` (the
  provider's own timestamp, used for ordering because delivery order is not guaranteed), `livemode`
  (so test-mode traffic is never mistaken for real billing), and `data` left as the provider's own
  object, deliberately unmodelled.
- **Processing is one transaction, system-scoped.** The processor runs in `withSystemTx`
  (`apps/api/src/db/tenant-tx.ts`): dedupe on `app.billing_events(provider, provider_event_id)`
  (000016, a global admin-only table), resolve the affected school/student, fold the status through
  the `@studafy/billing` state machine, and write the state change + audit + entitlement-version
  bump + outbox event together or not at all (SAD_16).
- **The state machine lives in `@studafy/billing`** (`packages/billing/src/state-machine.ts`,
  `system-transition.ts`), shared by the API and worker sides, with no `apps/api` import — the
  domain stays provider-blind and deploy-independent. See
  [`docs/database/stripe-webhook-state-machine.md`](../database/stripe-webhook-state-machine.md).

## Alternatives considered

- **Call the Stripe SDK directly from services and routes** — the pre-decision state. Testable only
  by stubbing the SDK, provider knowledge leaks into routes, and a second PSP duplicates
  SDK-specific code throughout. Rejected.
- **A generic multi-PSP wrapper package (e.g. a payments SDK)** — moves the provider logic behind a
  third-party abstraction instead of our own port. Rejected: it is a new dependency we don't
  control, and it still cannot express our domain's needs (pause/resume on suspension, entitlement
  versioning) without us extending it.
- **A message-bus-only boundary** (webhook → bus → domain) without a provider port — the bus hides
  the provider boundary but not the provider; every consumer still needs parsing/verification.
  Combined with an outbox ADR-0012 for _outbound_ events, the _inbound_ side stays port-based as
  the one place provider identity is known.

## Consequences

- Routes and services depend on the port type only, so the dining-table of Stripe-specific
  assumptions (test keys, SDK error shapes) is confined to `stripe/adapter.ts` and its tests.
- Adding a provider is an adapter + contract-test pass; the state machine and data model change
  only if the new provider's semantics genuinely differ.
- Webhook integrity (signature verification) is per-adapter behind the port: the processor trusts
  `ParsedWebhookEvent`, never the raw bytes, and idempotency is anchored on the event's own id.

## Review

Reviewed by `baderalhindi` on 2026-09-11.
