# AI add-on store compliance (R-07)

This covers `lib/src/features/ai` — the AI tab's feature hub and upsell screens — and the specific
question a store review raises for any app selling a digital subscription: does this app sell
anything itself, or only point at somewhere else that does?

## The rule

Apple's App Store Review Guideline 3.1.1/3.1.3 and Google Play's Payments policy both require an
app that unlocks paid digital content to sell that content through the platform's own in-app
purchase system — *unless* the app is only pointing the user at a purchase flow that happens
entirely outside the app (a "reader"/external-purchase pattern), in which case it must not
present, collect, or process payment information itself. There is no third option: an app cannot
show a price, a "Subscribe" button, or a card-entry form of its own and then hand off to a web
checkout — that reads as facilitating the purchase in-app while evading the platform's cut, which
is the exact pattern review guidelines exist to catch.

Studafy's AI add-on is billed through Stripe (`apps/api/src/modules/subscriptions`), on the web
only — `POST /api/subscriptions/ai/checkout` is mounted behind `requireChannel(AUTH_CHANNELS.WEB)`
(`ai-checkout-routes.ts`), so the mobile app cannot call it even if it wanted to. This app takes
the external-purchase path deliberately, not as a fallback.

## What this app does

- **No price is ever shown.** `AiUpsellCard` (`presentation/widgets/ai_upsell_card.dart`) lists
  what the add-on does (ask AI, quizzes and flashcards, summaries) and nothing about what it
  costs. The website's own purchase page confirms the exact price on Stripe's hosted checkout —
  this app never restates it, so there is nothing here that could be read as a storefront.
- **No purchase control.** The only control on the unsubscribed state is "Continue on the
  website" (`ai.upsell.continueOnWebsite`), which opens the system browser
  (`url_launcher`, `LaunchMode.externalApplication`) to `apps/web`'s `/account/ai` page
  (`AiSubscriptionPurchasePage.tsx`) — not an in-app webview, not a modal, not anything that could
  read as payment happening "inside" this app. There is no button anywhere in `features/ai` whose
  label or handler resembles "Subscribe", "Buy", or "Pay".
- **Student context, not payment data.** The link carries `studentId` and `priceId` as query
  parameters (`domain/ai_checkout_link.dart`'s `buildAiCheckoutUrl`) so the website knows which
  student the purchase is for and which price to open Stripe Checkout with. Neither this app nor
  that link ever carries a card number, billing address, or any other payment credential — those
  are entered on Stripe's own hosted page, reached from the website, never from here.
- **Entitlement is read-only.** `GET /api/ai/usage` (`application/ai_hub_providers.dart`) tells
  this app whether the add-on is active; it never writes to it. The only way an AI subscription
  changes state is the website checkout flow (or the school's own subscription lifecycle) — this
  app has no code path that creates, modifies, or cancels a subscription.

## Review checklist

Re-check this list whenever `features/ai` changes, and before every store submission that touches
it:

- [ ] No screen under `features/ai` displays a price, a currency amount, or "per month" copy.
- [ ] No screen under `features/ai` contains a button, link, or affordance labeled or behaving
      like "Subscribe", "Buy", "Upgrade", or "Pay".
- [ ] The only outbound action from the unsubscribed state is a system-browser launch
      (`LaunchMode.externalApplication`) — not an in-app `WebView`, not an in-app browser tab.
- [ ] No screen collects a card number, billing name/address, or any other payment credential.
- [ ] `apps/mobile` has no dependency on an in-app-purchase plugin (`in_app_purchase`,
      `purchases_flutter`, or similar) anywhere in `pubspec.yaml` for this feature.
- [ ] The entitlement read (`GET /api/ai/usage`) is the only network call this feature makes
      besides the checkout deep link itself — nothing under `features/ai` posts to a
      `/checkout`-shaped endpoint.

## Why "return -> entitlement reflected" doesn't need a deep-link callback

The acceptance criterion ("unsubscribed -> website checkout -> return -> entitlement reflected
without reinstall") could be read as needing a custom URL scheme carrying a success signal back
into the app. It doesn't: `AiHubScreen` re-invalidates its entitlement read
(`aiHubStatusProvider`) on every app-resume lifecycle event, plus manually via pull-to-refresh —
so returning to the app after finishing checkout in the system browser, by any means (switching
apps, backgrounding, the browser's own back button), is enough to show the new state. This also
sidesteps needing to register a second callback scheme alongside the OAuth one
(`core/auth/oauth_browser.dart`'s `studafy://auth/callback`), which the checkout flow has no
reason to share.
