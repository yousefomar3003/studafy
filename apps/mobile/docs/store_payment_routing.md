# Store-compliant payment routing (ST-304, supersedes R-07)

Which payments this app may hand off, and which it must not route to at all. Applies to the whole
app, not only `features/ai`.

## The rule

Apple's App Store Review Guideline 3.1.1 and Google Play's Payments policy both require a native
app that unlocks **digital** goods or services to sell them through the platform's own in-app
purchase. An app that doesn't offer the in-app purchase may still unlock content bought elsewhere
(Apple 3.1.3(b) "multiplatform services"), but it may not contain buttons, external links, or
other calls to action that direct the user to a purchasing mechanism outside the store — a
"Continue on the website" button, or copy saying where the add-on is billed, counts.

**Real-world** goods and services are exempt on both stores (Apple 3.1.3(e), Google Play's
physical-goods exemption), and may be paid for however the seller likes.

The earlier R-07 review (`ai_store_compliance.md`, ST-208) read this as "no price and no in-app
webview is enough" and shipped a "Continue on the website" button to the AI add-on's web checkout.
Outside the narrow storefront-specific link entitlements, that is exactly the steering 3.1.1
forbids, so ST-304 removed it.

## How each payment is routed

| What                                           | Kind                | In this app                                                                                   | Where it's bought                                               |
| ---------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| School fees / invoices                         | Real-world service  | "Pay on website" on an outstanding invoice opens `pay_online_url` in the system browser       | The school's payment page (Tap / redirect), `FinanceInvoiceTile` |
| Per-student AI add-on                          | Digital             | Entitlement is read (`GET /api/ai/usage`); unsubscribed shows `AiNotActiveCard`, no link/CTA | `apps/web` `/account/ai`, reached only from the web              |
| School's Studafy plan (checkout, portal, cancel) | Digital (B2B)     | Not present                                                                                   | `apps/web` `/portal/billing`, org admins                         |

Nothing is sold with an in-app purchase, so there is no store product to keep in sync.

## How it's enforced

- **Server:** every route that starts, manages or cancels a paid subscription is
  `requireChannel(AUTH_CHANNELS.WEB)` — a mobile token gets `403 CHANNEL_NOT_AUTHORIZED` whatever
  the client does. ST-304 closed the one that wasn't (`POST /api/subscriptions/checkout`). Pinned by
  `apps/api/src/modules/subscriptions/__tests__/store-payment-channel.test.ts`; a new purchase route
  belongs in its list.
- **Client:** `test/store_compliance/payment_routing_test.dart` scans `lib/` (hand-written code) and
  fails on:
  - a reference to a digital purchase page or route (`/account/ai`, `/billing`, `/pricing`,
    `/api/subscriptions`) or a call to a generated `SubscriptionsClient` purchase method;
  - a `launchUrl` call site not on its reviewed allowlist (sign-in, store listing, school fees,
    account deletion, file downloads) — adding one means checking it isn't a purchase link first;
  - an in-app-purchase or in-app webview dependency, or `LaunchMode.inAppWebView`/`inAppBrowserView`;
  - currency or purchase-steering words ("subscribe", "buy", "website", "billed", …) in the `ai`
    translation copy.
- **Widget and integration tests:** `ai_hub_screen_test.dart` asserts the unsubscribed state renders
  no button, tap target, price or steering copy; integration journey 5
  (`ai_not_active_round_trip_test.dart`) asserts tapping it launches nothing.

## Entitlement still arrives without a reinstall

An add-on bought on the web shows up on its own: `AiHubScreen` re-reads `aiHubStatusProvider` on
every app resume and on pull-to-refresh, and a push-notification tap can deep-link to the AI usage
screen. The app never needs to know where the purchase happened.

## Review checklist

Re-run before every store submission, and whenever anything touching payments, `features/ai` or
`features/parent`'s finance views changes:

- [ ] `payment_routing_test.dart` and `store-payment-channel.test.ts` pass.
- [ ] The unsubscribed AI state has no button, link, price, or copy about where or how to get the
      add-on — in-app and in the store listing (`store/listing-metadata.md`).
- [ ] The only payment hand-off is the school-fee invoice link, and it still points at the school's
      fee payment, never at anything digital.
- [ ] Store metadata answers "in-app purchases: none" on both stores.

## Known follow-ups

- The generated `SubscriptionsClient` (`core/api/generated/subscriptions/`) still carries the
  purchase methods because the `Subscriptions` tag is generated for mobile. Nothing calls them (the
  scan above fails if anything does) and the server refuses them, but excluding the tag in
  `pubspec.yaml` would drop them from the binary. Left out of ST-304 to avoid a full client
  regeneration.
- If the business wants the AI add-on purchasable on phones, that means store in-app purchase
  products (StoreKit / Play Billing) plus server-side receipt validation feeding the same
  `ai_subscriptions` entitlement — a separate feature, not a routing change.
