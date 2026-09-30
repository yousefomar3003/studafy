# SDK compliance inventory (child-directed services)

Studafy is used by students, including children, and a user's age is unknown until they sign in.
Google Play's Families policy therefore applies. This page records every SDK the app ships, what
each one sends off the device, and whether it is allowed in a child-directed app. It also covers
the Android advertising ID (AAID). ST-307 produced it. Re-audit whenever `pubspec.yaml` changes:
`test/store_compliance/child_directed_sdks_test.dart` fails until this page's direct-dependency
table matches the resolved `pubspec.lock`.

Audited against `pubspec.lock` as of 2026-09-29, with Flutter 3.47.1 (target SDK 36, min SDK 24)
and Firebase Android BoM 33.16.0, pulled in by `firebase_core` 3.15.2.

## What the policy requires

Google Play's Families policy, data-practices section:

1. **Restricted identifiers.** Apps must not transmit the AAID, SIM serial, build serial, BSSID,
   MAC, SSID, IMEI or IMSI from children or from users of unknown age.
2. **AD_ID permission.** Apps that target children must not request
   `com.google.android.gms.permission.AD_ID` when they target API 33 or higher.
3. **Ads SDKs.** Any ads SDK must be a Families Self-Certified Ads SDK.
4. **Other SDKs.** Every other SDK must be appropriate for a child-directed service and must not
   break rule 1.

Google certifies **ads** SDKs only. It publishes no certification list for crash-reporting,
messaging or sign-in SDKs. For those SDKs, "Eligible" below is **this audit's own verdict** against
rules 1, 2 and 4, backed by the evidence listed. It is not a Google certification. The verdict does
not replace the Play Console "Target audience and content" and "Data safety" declarations, which a
human submits.

## Verdict

- **No ads, analytics, attribution or sign-in SDK is present.** No package is removed or replaced.
- **Sign-in uses no SDK.** It is OAuth in the system browser (`lib/src/core/auth/oauth_browser.dart`),
  built from `url_launcher` and `app_links`. That means Custom Tabs on Android and
  ASWebAuthenticationSession on iOS. No `google_sign_in`, Facebook or other identity SDK controls
  access to the app.
- **AAID.** None of the 43 Google and Sentry Maven artifacts the app resolves declares `AD_ID`, and
  `play-services-ads-identifier` is not among them. The app's manifest also strips the permission
  with `tools:node="remove"`, so a future dependency cannot add it without anyone noticing. The app
  targets API 36 and lacks the permission, so Google Play services returns
  `00000000-0000-0000-0000-000000000000` to any code in the process that asks.
- **Other restricted identifiers.** No plugin and no transitive AAR requests the phone-state, Wi-Fi
  state or location permissions. Those permissions are the only way to read IMEI, IMSI, SIM serial,
  build serial, BSSID or SSID. On API 30 and higher, Android returns a constant instead of the MAC
  address.
- **Tightened by this change.** FCM auto-init is now off on both platforms, so Firebase creates no
  push token while the user's age is still unknown. `FirebasePushService.initialize()` asks for the
  token explicitly, and only after sign-in. An FCM token is not one of the restricted identifiers
  in rule 1. This change is data minimisation, not a policy fix.

## Direct dependencies

Status values:

- **Eligible** means the SDK sends no restricted identifier and runs no ads or tracking.
- **Eligible, on-device only** means the SDK makes no network calls at all.

| Package | Version | Purpose | Data leaving the device | Status |
| --- | --- | --- | --- | --- |
| `flutter` | SDK | Framework | None | Eligible, on-device only |
| `go_router` | 17.3.0 | Navigation | None | Eligible, on-device only |
| `flutter_riverpod` | 3.3.2 | State management | None | Eligible, on-device only |
| `google_fonts` | 6.3.3 | Inter typography | None. Fonts ship as assets and `app_bootstrap.dart` sets `GoogleFonts.config.allowRuntimeFetching = false`, so the app never calls `fonts.gstatic.com` | Eligible, on-device only |
| `dio` | 5.11.0 | HTTP client | Studafy API only (first party) | Eligible |
| `retrofit` | 4.10.0 | Typed API client | Studafy API only | Eligible |
| `json_annotation` | 4.12.0 | JSON codegen annotations | None | Eligible, on-device only |
| `web_socket_channel` | 3.0.3 | Realtime gateway | Studafy realtime gateway only | Eligible |
| `flutter_secure_storage` | 9.2.4 | Token storage (Keystore / Keychain) | None | Eligible, on-device only |
| `app_links` | 6.4.1 | OAuth callback deep link | None | Eligible, on-device only |
| `url_launcher` | 6.3.2 | Opens the system browser (sign-in, downloads) | None. The browser makes the requests | Eligible |
| `easy_localization` | 3.0.8 | Translations from bundled assets | None | Eligible, on-device only |
| `intl` | 0.20.2 | Formatting | None | Eligible, on-device only |
| `firebase_core` | 3.15.2 | Firebase bootstrap | Firebase Installation ID (FID), app-scoped | Eligible |
| `firebase_messaging` | 15.2.10 | Push notifications | FCM token plus FID, created only after sign-in (auto-init off). The token is registered with Studafy's API | Eligible |
| `firebase_crashlytics` | 4.3.10 | Crash reporting | Crash stack, device model, OS version, FID, Crashlytics installation UUID, app-assigned user UUID after sign-in. Firebase Sessions sends session start events. No AAID: Analytics is not linked | Eligible |
| `sentry_flutter` | 8.14.2 | Crash and performance monitoring | Crash stack, device model, OS version, Sentry installation UUID, app-assigned user UUID. `sendDefaultPii = false`. Off when `SENTRY_DSN` is empty | Eligible. See open item 2 |
| `package_info_plus` | 9.0.1 | Version for the Sentry release tag | None | Eligible, on-device only |
| `flutter_local_notifications` | 18.0.1 | Shows foreground pushes | None | Eligible, on-device only |
| `drift` | 2.34.3 | Offline cache (SQLite) | None | Eligible, on-device only |
| `sqlite3_flutter_libs` | 0.5.42 | Bundled SQLite | None | Eligible, on-device only |
| `path_provider` | 2.1.6 | App directories | None | Eligible, on-device only |
| `path` | 1.9.1 | Path utilities | None | Eligible, on-device only |
| `file_picker` | 11.0.3 | Material uploads through the system picker | None. Uploads go to Studafy's API | Eligible |
| `image_picker` | 1.2.3 | Camera capture for materials | None. Uploads go to Studafy's API | Eligible |
| `mime` | 2.0.0 | MIME detection | None | Eligible, on-device only |
| `flutter_pdfview` | 1.4.5 | PDF rendering (`AndroidPdfViewer` / PDFKit) | None | Eligible, on-device only |

Dev dependencies such as `integration_test` and `shared_preferences` are not in this table.
Flutter leaves dev-dependency plugins out of release builds.

## Native Android libraries

Resolved from each plugin's `android/build.gradle` and walked through their Maven POMs.

- **Google Play services:** `play-services-base`, `-basement`, `-tasks`, `-stats`,
  `-cloud-messaging`.
- **Firebase:** `firebase-common`, `-components`, `-installations`, `-messaging`, `-crashlytics`,
  `-sessions`, `-datatransport`, `-encoders*`, `-iid-interop`, `-measurement-connector`,
  `-config-interop`.
- **Sentry:** `io.sentry:sentry-android` 7.22.4.
- **Other:** AndroidX, Tink, `com.github.marain87:AndroidPdfViewer`,
  `eu.simonbinder:sqlite3-native-library`.

`firebase-measurement-connector` is an interface library. It only talks to Google Analytics if
Analytics is present, and Analytics is not.

Every permission the plugins and AARs declare:

- `INTERNET`
- `ACCESS_NETWORK_STATE`
- `WAKE_LOCK`
- `POST_NOTIFICATIONS`
- `VIBRATE`
- `com.google.android.c2dm.permission.RECEIVE`

The app adds `CAMERA` and `RECEIVE_BOOT_COMPLETED` itself. None of these permissions exposes a
restricted identifier.

## iOS

The pods mirror the plugins above. No `FirebaseAnalytics` pod and no `AdSupport` or
`AppTrackingTransparency` usage means no IDFA. `Info.plist` sets
`FirebaseMessagingAutoInitEnabled` to `false`. `NSUserTrackingUsageDescription` must stay absent.

## Verification

| Check | Where | What it proves |
| --- | --- | --- |
| Direct dependencies match this page | `test/store_compliance/child_directed_sdks_test.dart` | A new SDK cannot ship without an entry here |
| No ads, analytics, attribution or identity SDK anywhere in the lockfile, transitive included | same | The verdict above still holds |
| Manifest strips `AD_ID`, FCM auto-init is off on both platforms, no tracking-usage string | same | The configuration this page relies on is still in place |
| Target SDK ≥ 33 | `android/app/src/androidTest/.../ChildDirectedComplianceTest.kt` | The AD_ID rule and AAID zeroing apply |
| The installed APK requests no restricted-identifier permission | same | Checks the real merged manifest, every AAR included, not the source manifest |
| `AdvertisingIdClient` returns the all-zeros ID | same | The AAID is disabled at runtime |

The instrumentation test is in the androidTest APK that `mobile-integration.yml` sends to Firebase
Test Lab (Pixel 7, API 34), so it runs with every journey. To run it locally against a device or
emulator with Google Play services and Android 13 or later:

```
cd android && ./gradlew app:connectedDevDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.studafy.studafy_mobile.ChildDirectedComplianceTest
```

`play-services-ads-identifier` is an `androidTestImplementation` dependency. Its own manifest
declares `AD_ID`, and that permission merges into the test APK only. Instrumentation runs under
the app's UID, so the zeros check sees the app's permissions, not the test APK's.

## Open items (need a human or credentials)

1. **Play Console declarations.** Target audience must include the under-13 age groups. The Data
   safety answers must match `store/privacy-labels.md`. Families policy acceptance is a console
   step.
2. **Sentry stores the client IP.** Sentry's server records the sender's IP address even with
   `sendDefaultPii = false`. Enable *Project Settings → Security & Privacy → Prevent Storing of IP
   Addresses* in each environment's Sentry project. Firebase has no equivalent setting to review.
3. **Firebase data-processing terms.** Accept the Firebase Data Processing and Security Terms in the
   Firebase console, as COPPA and GDPR-K processor coverage requires. This is a legal step, not a
   code change.
4. **Not run on this machine.** The audit machine had no JDK or Android SDK, so neither a Gradle
   build nor `ChildDirectedComplianceTest` ran here. The first Test Lab run is the first real
   execution.
