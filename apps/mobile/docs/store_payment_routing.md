# Store-compliant payment routing (ST-304, supersedes R-07; AI add-on in-app purchase)

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
| Per-student AI add-on                          | Digital             | Unsubscribed shows `AiNotActiveCard`, then `AiStoreOfferCard`: App Store / Google Play in-app purchase with the store's own price | In the app through the store (`features/ai/store/`); on the web through Tap/Stripe at `/account/ai` |
| School's Studafy plan (checkout, portal, cancel) | Digital (B2B)     | Not present                                                                                   | `apps/web` `/portal/billing`, org admins                         |

The AI add-on is one store product, `studafy_ai_monthly`, the same id in App Store Connect and the
Play Console (`docs/runbooks/in-app-purchase-setup.md`). The app never shows a price of its own: it
shows the store's localized price, and never mentions the web price or the website. A student who
bought on the web sees the add-on active in the app, and the reverse — both feed the same
`ai_subscriptions` entitlement.

## How it's enforced

- **Server:** every route that starts, manages or cancels a Tap/Stripe subscription is
  `requireChannel(AUTH_CHANNELS.WEB)` — a mobile token gets `403 CHANNEL_NOT_AUTHORIZED` whatever
  the client does. ST-304 closed the one that wasn't (`POST /api/subscriptions/checkout`). Pinned by
  `apps/api/src/modules/subscriptions/__tests__/store-payment-channel.test.ts`; a new web purchase
  route belongs in its list. The reverse holds for the store: `POST
  /api/subscriptions/ai/store/purchases` accepts only a mobile session, verifies the receipt with
  Apple or Google, and only for the student whose id the purchase carries (`store-routes.test.ts`,
  `store-purchase-processing.test.ts`).
- **Client:** `test/store_compliance/payment_routing_test.dart` scans `lib/` (hand-written code) and
  fails on:
  - a reference to a digital purchase page or route (`/account/ai`, `/billing`, `/pricing`,
    `/api/subscriptions`) or a call to a generated `SubscriptionsClient` web-purchase method;
  - the in-app purchase plugin or the two store methods (`getAiStoreConfig`,
    `registerAiStorePurchase`) used anywhere but `lib/src/features/ai/store/`;
  - a `launchUrl` call site not on its reviewed allowlist (sign-in, store listing, school fees,
    account deletion, file downloads) — adding one means checking it isn't a purchase link first;
  - a missing `in_app_purchase` (the stores' own billing), a third-party purchase SDK, an in-app
    webview dependency, `LaunchMode.inAppWebView` anywhere, or
    `LaunchMode.inAppBrowserView` outside sign-in (`oauth_browser.dart` uses it on iOS so login
    doesn't leave for Safari; ST-310);
  - currency or purchase-steering words ("subscribe", "buy", "website", "billed", …) in the `ai`
    translation copy (the not-active notice), and a currency, or the website, in the `aiStore`
    purchase copy — its one price is the store's, substituted for `{price}`.
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
- [ ] The unsubscribed AI state offers the add-on only through the store sheet, with the store's
      price, Restore purchases, the renewal terms and the privacy (and, on iOS, terms of use)
      links — and nothing about the website, in-app or in the store listing
      (`store/listing-metadata.md`).
- [ ] The store product `studafy_ai_monthly` is approved / active in App Store Connect and the Play
      Console, and the api's store values are set for the tier (`docs/runbooks/in-app-purchase-setup.md`).
- [ ] The only payment hand-off is the school-fee invoice link, and it still points at the school's
      fee payment, never at anything digital.
- [ ] Store metadata lists the in-app purchase on both stores, and App Privacy / Data safety declare
      purchase history (`store/privacy-labels.md`).

## Known follow-ups

- The generated `SubscriptionsClient` (`core/api/generated/subscriptions/`) also carries the web
  purchase methods, because the `Subscriptions` tag is generated for mobile — and must stay, since
  the two store methods live under it. Nothing calls the web ones (the scan above fails if anything
  does) and the server refuses them from a mobile session.
- A purchase the store delivers while the AI tab is closed is reported the next time the tab
  opens (the store redelivers unfinished purchases). Listening at app start would report it sooner.
