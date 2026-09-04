# Critical-journeys E2E suite (ST-246)

`apps/web/e2e/critical/` — a real-backend Playwright suite covering the seven journeys the ticket
names, distinct from `apps/web/e2e/` (which stubs every API call and runs only `vite dev`, see that
directory's own `playwright.config.ts`). Run it with `bun run e2e:critical` from `apps/web`, or the
whole thing from the repo root via the `critical-journeys` job in
`.github/workflows/e2e-critical.yml` (nightly + `workflow_dispatch`, the manual "pre-release" trigger
— see that workflow's own header for why).

## What's real, what's faked, and why

| Dependency                                  | Status                           | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres, Redis, `apps/api`, `apps/workers` | **Real**                         | The suite's whole point — see `playwright.critical.config.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Mock OAuth identity provider                | **Real**, dev/E2E-only code path | `apps/api/src/dev/mock-idp.ts`, mounted at `/mock-idp` and wired as a third "mock" provider (`oauth/mock-route.ts`, `oauth/mock-config.ts`) alongside the real Google/Microsoft routes — same shape, hard-disabled outside dev/test (`MOCK_OAUTH_ISSUER_URL` refuses to activate when `NODE_ENV`/`APP_ENV` is `production`, and `env.ts` refuses to even _boot_ with it set in that tier). Every seeded persona (`db/seeds/mock-credentials.ts`) already has a `provider='mock'` identity row. |
| ERPNext (invoice→payment)                   | **Real sandbox**                 | `ERPNEXT_API_URL`/`ERPNEXT_API_KEY` — confirmed a disposable target safe for repeated automated writes. Requires `E2E_ERPNEXT_API_URL`/`E2E_ERPNEXT_API_KEY` repository secrets in CI; local runs read the root `.env`.                                                                                                                                                                                                                                                                        |
| Anthropic (AI ask)                          | **Faked**                        | No free "test mode" exists — every real call costs money. `tests/mocks/fake-anthropic.ts` stands in for `POST /v1/messages` (streaming and non-streaming); `AnthropicProvider` itself is unmodified real code, only `ANTHROPIC_BASE_URL` points elsewhere. Retrieval (embeddings, hybrid search, citation resolution) is **fully real** — this repo has no real embeddings provider at all, only the same deterministic mock embedder production runs on.                                      |
| Stripe (subscription checkout)              | **Faked**                        | `tests/mocks/fake-stripe-provider.ts` implements `PaymentProviderPort` in memory and is injected via `createApp({ stripeProvider })` in `tests/e2e/server.ts` — the same DI seam the codebase already uses to test this port, not a network-level fake. Webhook signature verification is not simulated (see that file's doc comment); everything else — checkout-session creation, seat counting, the real `@studafy/billing` state machine processing a real webhook POST — is real.         |

## The composition root

`apps/api/tests/e2e/server.ts` is a **second entrypoint**, not a flag inside `src/index.ts` —
production's bootstrap has no business knowing how to wire a fake payment provider. It builds the
same `createApp()` production does, with the fake Stripe provider always on and `ANTHROPIC_BASE_URL`
pointed at the fake Anthropic server. `apps/web/e2e/critical/support/global-setup.ts` brings up the
whole stack (Postgres/Redis → migrate → seed → this suite's own tiny extra fixture → fake Anthropic →
this API process → `apps/workers`) before any spec runs, and `global-teardown.ts` tears it down after.
Ports are fixed constants (`support/ports.ts`), not dynamically allocated — one process, one port
each, no runtime handshake needed between setup and the specs.

## Journey-by-journey: what's actually browser-driven

**The web app is an admin/principal/finance portal.** There is no teacher, student, or parent web
UI anywhere in `apps/web` — those roles' screens exist only in the Flutter mobile app. This is a fact
about the product, not a gap this suite invented around; every journey below says plainly which of
its steps a browser can reach and which it can't.

| #   | Journey                           | Spec                                | Browser-driven                                                                                  | API-driven (no web UI exists)                                                                                                                                                     |
| --- | --------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Registration → verification       | `registration-verification.spec.ts` | Full onboarding form; Turnstile alone is stubbed (see the spec's own comment)                   | Reading the verification token off the real network response (never rendered — email-only by design) and calling verify-email                                                     |
| 2   | Invitation activation             | `invitation-activation.spec.ts`     | `/invite/:token` and the real mock-OAuth redirect round trip                                    | Creating the invitation (admin API) to get a raw token with no inbox to check                                                                                                     |
| 3   | Attendance record                 | `attendance-record.spec.ts`         | Admin's attendance oversight dashboard (`/portal/principal/attendance`)                         | Opening a session and recording it (teacher-only, mobile-only)                                                                                                                    |
| 4   | Grade submit → approve → publish  | `grade-workflow.spec.ts`            | Admin's approval queue (`/portal/approvals`) — approving _is_ publishing, one atomic transition | Grade entry and submit (teacher-only, mobile-only); the published-grade read (student/parent-only route, no web page at all)                                                      |
| 5   | Invoice → payment                 | `invoice-payment.spec.ts`           | Recording the payment (`/portal/finance/payments/new`)                                          | Registering a fresh school (ERPNext-provisioning needs a real sandbox site, so the pre-seeded demo tenant can't be reused — see the spec), fee structure + invoice batch creation |
| 6   | AI ask with citations             | `ai-ask-citations.spec.ts`          | **None** — no Ask AI screen exists in `apps/web`                                                | The entire journey: `POST /api/ai/students/{id}/ask`, asserted against the real SSE stream                                                                                        |
| 7   | Subscription checkout (test mode) | `subscription-checkout.spec.ts`     | Full billing UI (`/portal/billing` → Change plan → Continue to checkout)                        | Syncing plan prices and delivering the confirmation webhook (nothing plays "Stripe" in a browser)                                                                                 |

## Personas

`support/personas.ts` — seeded accounts from `db/seeds/mock-credentials.ts`, signed in via
`support/auth.ts`'s `loginInBrowser` (drives the real "Continue with Mock" button) or `apiLoginAs`
(the same OAuth round trip, done headlessly for the steps with no web UI to click through).

## Known follow-ups

- **Invoice→payment's fee category** (`invoice-payment.spec.ts`) assumes ERPNext's stock "Tuition"
  Fee Category is present on the sandbox with no further setup. This is the one assumption in the
  whole suite that has never been exercised against the real sandbox before (no prior integration
  test in this repo posts a Fee Structure to it) — expect the first real CI run to need a one-line
  adjustment here if the sandbox's master data differs.
- **Subscription checkout's post-webhook assertion** stays deliberately modest (the webhook is
  accepted and the billing page still renders) rather than asserting exactly which plan is now
  active — whether `checkout.session.completed` alone flips `app.subscriptions.plan_id`, or whether
  that needs a following `customer.subscription.*` event, wasn't fully resolved during research.
  Worth tightening once observed against a real run.
- Deeper UI assertions on the attendance and approvals dashboards (specific rows, specific counts)
  are intentionally light in this first version — enough to prove the real page renders against
  live data, not a pixel-level audit.
