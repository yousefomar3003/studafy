# In-app purchase of the AI add-on (App Store / Google Play)

Students buy the AI add-on **inside the mobile app** through Apple's and Google's own billing; the
website keeps selling it through Tap/Stripe. Both stores require their billing for a digital
subscription used in the app (App Store Review Guideline 3.1.1, Google Play Payments policy), and
forbid linking out to a cheaper web checkout from the app. Tuition and school fees are a real-world
service and stay outside in-app purchase; the school plan is sold to the school on the website.

Code: `apps/api/src/modules/subscriptions/store/` (server), `apps/mobile/lib/features/ai/store/`
(app). Store purchases land in the same billing ledger (`app.billing_events`, provider `apple` /
`google`) and the same per-student AI add-on (`app.ai_subscriptions`) as a web purchase.

## How it works

1. The app asks `GET /api/subscriptions/ai/store/config` whether the add-on is for sale to this
   student (a store is configured and the school's own plan is live) and which product to show.
2. The student buys `AI_STORE_PRODUCT_ID` with the store's own sheet. The app stamps the purchase
   with the student's id (Apple `appAccountToken`, Google `obfuscatedAccountId`; Google also carries
   the school id as `obfuscatedProfileId`).
3. The app sends the receipt to `POST /api/subscriptions/ai/store/purchases` (mobile sessions only).
   The API verifies it with the store (Apple's signature; Google's Developer API), checks the
   product, that it is active, that it carries this student's id, and that no other student has
   claimed it, then turns the add-on on. Google purchases are acknowledged here — Play refunds a
   purchase left unacknowledged for three days.
4. Renewals, billing failures, expiry, refunds and revocations arrive later as store notifications
   (below) and move the same subscription. "Restore purchases" re-sends the receipt (step 3);
   it is idempotent.

Cancelling is done in the store's own subscription settings (the app links there); access lasts to
the end of the paid period.

## Values

| Where                                               | Value                         | dev / staging / prod                                                         |
| --------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `infra/deploy/environments/<tier>.env`              | `AI_STORE_PRODUCT_ID`         | `studafy_ai_monthly` (same id in both stores)                                |
|                                                     | `APPLE_IAP_BUNDLE_ID`         | `com.studafy.studafyMobile.dev` / `.staging` / `com.studafy.studafyMobile`   |
|                                                     | `APPLE_IAP_APP_APPLE_ID`      | App Store Connect → the app → App Information → **Apple ID** (a number)      |
|                                                     | `GOOGLE_PLAY_PACKAGE_NAME`    | `com.studafy.studafy_mobile.dev` / `.staging` / `com.studafy.studafy_mobile` |
| api app secret (`TF_VAR_secrets_app_secret_values`) | `GOOGLE_PLAY_SERVICE_ACCOUNT` | the service account's JSON key, on one line                                  |
|                                                     | `GOOGLE_PLAY_RTDN_TOKEN`      | `openssl rand -hex 32`                                                       |

Each store is off while its values are empty; the api refuses to boot with a half-configured store
(`apps/api/src/env.ts`). Locally, put the same names in `.env`.

## App Store (once per app)

1. **Agreements.** App Store Connect → Business → accept the **Paid Apps** agreement and add bank and
   tax details. Without it, no product can be bought, even in sandbox.
2. **Product.** The app → Monetization → Subscriptions → create a subscription group "Studafy AI",
   then an auto-renewable subscription with Product ID `studafy_ai_monthly`, duration 1 month, a
   price, and a localized display name and description (English and Arabic). Add the review
   screenshot (the purchase screen) and review notes.
3. **Billing grace period** (recommended): Subscriptions → Billing Grace Period → On, 16 days. The
   student keeps AI while Apple retries the card; the API keeps the add-on `past_due` meanwhile.
4. **Server notifications.** The app → App Information → App Store Server Notifications →
   **Version 2**, Production URL `https://api.studafy.com/api/subscriptions/webhook/apple`, Sandbox
   URL the staging API's same path. Use "Request a Test Notification" — the API answers 200
   (`ignored`).
5. **Sandbox testers.** Users and Access → Sandbox → Test Accounts. Sign in with one on a device
   under Settings → App Store → Sandbox Account.
6. Put the bundle id and the Apple ID number into the tier's `.env` file and deploy.

The API accepts sandbox purchases on every tier on purpose — App Review buys with a sandbox account
against the production server. Every billing event records the environment, so a sandbox purchase is
never counted as revenue (`payload->>'environment'`).

## Google Play (once per app)

1. **Payments profile.** Play Console → Settings → Payments profile, linked to the developer account.
2. **Product.** The app → Monetize → Products → Subscriptions → create `studafy_ai_monthly` with one
   base plan (monthly, auto-renewing), prices, and a grace period (recommended: 7 days) and account
   hold. The app must have been uploaded to a testing track with the `BILLING` permission (the
   `in_app_purchase` plugin adds it) before products can be created.
3. **Service account** for the server:
   1. Google Cloud console → the project linked to Play → IAM → Service Accounts → create
      `studafy-play-billing`; Keys → Add key → JSON. That file is `GOOGLE_PLAY_SERVICE_ACCOUNT`.
   2. Enable the **Google Play Android Developer API** in that project.
   3. Play Console → Users and permissions → Invite new users → the service account's email, with
      app permissions **View financial data** and **Manage orders and subscriptions**. It can take up
      to a day before the API accepts it.
4. **Real-time Developer Notifications** (Pub/Sub):
   1. Cloud console → Pub/Sub → create topic `play-billing`. Grant
      `google-play-developer-notifications@system.gserviceaccount.com` the **Pub/Sub Publisher** role
      on it.
   2. Create a **push** subscription on the topic, endpoint
      `https://api.studafy.com/api/subscriptions/webhook/google?token=<GOOGLE_PLAY_RTDN_TOKEN>`.
   3. Play Console → the app → Monetize → Monetization setup → Real-time developer notifications →
      the topic name `projects/<project>/topics/play-billing` → **Send test notification** (the API
      answers 200 `ignored`).
5. **License testers.** Play Console → Settings → License testing → add the testers' Google
   accounts. Their purchases are free test purchases that renew every few minutes.
6. Put the package name into the tier's `.env` file, the two secrets into the api app secret, and
   deploy.

## Checking it works

- `GET /api/subscriptions/ai/store/config` as a student returns `enabled: true` and the platform.
- After a test purchase: the student's row in `app.ai_subscriptions` is `active`, and
  `app.billing_events` has a `processed` row with provider `apple`/`google` and event id
  `<platform>:purchase:<transaction id>`.
- After the store's renewal or expiry: further `processed` rows with event id
  `<platform>:notification:<id>`.
- A notification answered `unattributed` is one for a purchase the app has not reported yet (the
  app reports on completion; the store resends). Many of them mean the app's report is failing —
  check the API logs for `POST /api/subscriptions/ai/store/purchases`.

## Refunds and disputes

Apple and Google own refunds for in-app purchases. A refund arrives as a notification (`REFUND` /
`REVOKED`) and ends the add-on immediately. Support cannot refund a store purchase from Studafy;
point the student to Apple (reportaproblem.apple.com) or Google Play's order history.
