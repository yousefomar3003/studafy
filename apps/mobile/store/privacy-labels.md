# Privacy nutrition labels

Apple App Privacy (App Store Connect → App Privacy) and Google Play Data Safety (Play Console →
App content → Data safety) answers, mapped from what this app's code actually does — its
dependencies (`pubspec.yaml`), its native permissions (`AndroidManifest.xml`,
`ios/Runner/Info.plist`), and its own monitoring/push code — not a generic education-app template.
**Re-derive this whenever a dependency, permission, or data flow changes**; a stale label is itself
a store-policy violation (both stores can suspend an app whose label doesn't match its actual
behavior), separate from whatever else is wrong with a submission.

## How data leaves the device

Three destinations, and only three — there is no analytics SDK, ad SDK, or data broker anywhere in
`pubspec.yaml`:

1. **Studafy's own API** (`apps/api`, via `dio`/`retrofit` — `lib/src/core/api`). Everything the
   app displays (timetable, grades, attendance, assignments, materials, finance receipts,
   discipline incidents) round-trips through here. First-party, not a third party for either
   store's purposes.
2. **Firebase** (`firebase_core`, `firebase_messaging`, `firebase_crashlytics`) — Google, for push
   notifications and crash reporting.
3. **Sentry** (`sentry_flutter`) — for crash/performance diagnostics, DSN-configured per
   environment (`MonitoringConfig.fromEnvironment`, empty/disabled in local dev).

Firebase and Sentry are both **diagnostic/functionality vendors**, not ad or tracking networks —
neither receives data used to serve ads or is used to correlate the user across other companies'
apps/sites. Both stores' "tracking" questions (Apple's App Tracking Transparency category; Play's
"Is this data shared for tracking purposes") should be answered **No** on that basis. `pubspec.yaml`
has no `app_tracking_transparency` dependency and no IDFA usage — no ATT prompt is needed at all.

## What's collected, by category

| Category (Apple label term) | Data type | Collected? | Linked to identity? | Purpose | Source |
| --- | --- | --- | --- | --- | --- |
| Identifiers | User ID | Yes | Yes | App Functionality | `AuthSession.userId` — the JWT `sub` claim, an app-assigned UUID. Read explicitly *instead of* email/name for this purpose (see `auth_session.dart`'s doc comment) — passed to `CrashReporter.identifyUser` (`monitoring_providers.dart`) and used to scope every API call. |
| Identifiers | Device ID | Yes | Yes | App Functionality | The FCM push token, registered to `POST /api/auth/devices` with the signed-in bearer token (`push_service.dart`'s `_registerToken`) — so it's tied to the account, not anonymous. |
| Diagnostics | Crash Data | Yes | Yes (by User ID only) | App Functionality, Analytics | Sentry + Crashlytics (`crashlytics_reporter.dart`, `sentry_reporter.dart`). `setUserIdentifier`/`SentryUser` carry only the app-assigned UUID — never email, name, or any freeform PII field, which `PiiScrubber` (`pii_scrubber.dart`) redacts from every manual breadcrumb/error reason before either SDK receives it (email pattern + a fixed key list: password, token, email, phone, ssn, etc.). Caveat below. |
| Diagnostics | Performance Data | Yes | Yes (by User ID only) | App Functionality | Sentry performance monitoring, same identity scoping as Crash Data. |
| Financial Info | Payment Info | Yes | Yes | App Functionality | Tuition/fee receipts, read-only (`parent/presentation/receipt_viewer_screen.dart`). The app never collects a card number or bank detail itself — Stripe checkout happens on the *website*, not in this app (`docs/ai_store_compliance.md`) — but it does display payment history fetched from Studafy's API, which both stores' definitions treat as "collected" regardless of which side initiated the request. |
| Contact Info | Name, Email, Phone | **No** | — | — | Sign-in is OAuth via the system browser (`oauth_browser.dart`, Microsoft/Google) — the IdP exchange happens outside app code, and `AuthSession` deliberately reads only the `sub` claim, never a name/email claim, from the resulting token. The app itself never renders or stores a login form. |
| User Content | Photos or Videos | Yes | Yes | App Functionality | Camera captures for teaching materials (`teacher_content_screen.dart`, `ImageSource.camera` only — confirmed no gallery/photo-library access anywhere in the app, consistent with `Info.plist` declaring only `NSCameraUsageDescription` and no photo-library usage string). |
| User Content | Other User Content | Yes | Yes | App Functionality | Uploaded materials (`file_picker`), assignment submissions, class announcements, discipline incident reports — all first-party, all tied to the authenticated user. |
| Usage Data | Product Interaction | No | — | — | No analytics/event-tracking SDK is present. |
| Other Data | Education records (grades, attendance, timetable, assignments) | Yes | Yes | App Functionality | No Apple label category maps to "education records" directly; classified as **Other Data**, linked, App Functionality only. Google Play's Data Safety form has an explicit "App activity" / education-adjacent option — use its closest match there rather than a generic bucket if the current form version offers one. |

## Not shared with third parties, not used for tracking

Every row above is **first-party** (Studafy's own backend) or a **service-provider** relationship
(Firebase, Sentry — processing on Studafy's behalf, not for their own independent purposes). Answer
"No" to both stores' third-party-sharing and tracking questions across every data type in this
table. If that ever changes (an ads SDK, an analytics SDK that resells data, a new
share-with-a-partner integration), this table and both store answers need to be revisited together
— don't let the label drift from the code.

## Caveat: Crashlytics' own automatic collection isn't scrubbed

`PiiScrubber` only covers **manual** breadcrumbs/errors the app code explicitly passes through
`CrashReporter` (`composite_crash_reporter.dart`, `crashlytics_reporter.dart`'s own doc comment
says so directly: "Crashlytics has no `beforeSend`/`beforeBreadcrumb` hook of its own... everything
it receives here is already scrubbed... plus a defensive pass on the free-text fields this class
controls directly"). Crashlytics' own **automatic** native-crash capture (device model, OS version,
uncaught native stack traces) is Google-managed and outside app code's reach entirely — this is
normal and expected for a crash SDK, not a bug, but it means "Diagnostics" in the label should be
answered as standard device/crash diagnostics collection, not as "fully scrubbed" — don't
overstate the scrubbing's scope when filling out either form.

## Data retention / deletion tie-in

Both forms ask how long data is retained and whether users can request deletion. Answer "Yes" —
self-service deletion exists (`POST /api/privacy/me/dsr`, the mobile Profile tab, and
`/account/delete` / `/legal/delete-account` on the web; see `review-checklist.md`'s resolved
account-deletion item). Requests are processed within 30 days
(`app.data_subject_requests.sla_due_at`); anything retained past that under a legal hold is
recorded per-request in `retained_tables`, not silently kept.
