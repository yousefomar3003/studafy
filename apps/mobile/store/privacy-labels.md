# Privacy declarations

The answers for App Store Connect → App Privacy and Play Console → App content → Data safety, the
iOS privacy manifests behind them, and the code each answer comes from. ST-308 produced this page.
It covers the release build only. Dev-flavor-only code (the mock sign-in) is out of scope.

`test/store_compliance/privacy_declarations_test.dart` fails when these drift apart:

- the data types in `ios/Runner/PrivacyInfo.xcprivacy` and the Apple table below
- the iOS plugins in the build and the manifest inventory below
- the policy and deletion URLs here, in `listing-metadata.md`, and in the app

Audited 2026-10-01 against `pubspec.lock`, Flutter 3.47.1, Firebase iOS SDK 11.15.0, and Sentry
Cocoa 8.46.0. Re-audit whenever a dependency, a permission, or an API call that sends user data
changes. A stale label is a policy violation on both stores.

## Where data goes

| Destination | What it receives | Relationship |
| --- | --- | --- |
| Studafy API (`api.studafy.com`, `dio` / `retrofit` / `web_socket_channel`) | Everything the user enters or uploads, the push token, and the sign-in exchange | First party |
| Firebase (Google) | FCM token and Firebase Installation ID (`firebase_messaging`). Crash reports and session events (`firebase_crashlytics`, which pulls in FirebaseSessions) | Service provider |
| Sentry | Crash and performance events (`sentry_flutter`), only when `SENTRY_DSN` is set | Service provider |
| Anthropic, through the Studafy API and never from the device | AI questions and material text, after in-app consent (`../docs/ai_data_sharing_consent.md`) | Service provider |

There is no ads, analytics, or attribution SDK. `docs/sdk_compliance_inventory.md` (ST-307) is the
per-SDK audit. Neither the AAID nor the IDFA is read. No data is used for tracking on either store,
so no App Tracking Transparency prompt is needed.

All production endpoints are `https` / `wss`. Only the dev flavor uses cleartext, against
`10.0.2.2`.

## App Store Connect: App Privacy

Answer **"Yes, we collect data"**. Every type below is **linked to the user's identity** and **not
used for tracking**. The only purpose is **App Functionality**. The manifest key is the value in
`ios/Runner/PrivacyInfo.xcprivacy`.

| App Privacy type | Manifest key | Evidence in the code |
| --- | --- | --- |
| Contact Info → Email Address | `NSPrivacyCollectedDataTypeEmailAddress` | The sign-in the app starts hands the identity provider's authorization code to the API, which exchanges it for an ID token that carries the email (`oauth/google-route.ts`, `oauth/microsoft-route.ts`). The reviewer email/password form sends it directly (`login_screen.dart`). The account is keyed by the email the school invited. |
| Identifiers → User ID | `NSPrivacyCollectedDataTypeUserID` | `AuthSession.userId` is the JWT `sub`. It scopes every API call and is set as the crash-report user (`monitoring_providers.dart`). |
| Identifiers → Device ID | `NSPrivacyCollectedDataTypeDeviceID` | The FCM token, registered to `POST /api/auth/devices` with the bearer token (`push_service.dart`). The token is created only after sign-in (ST-307). The Firebase Installation ID and the Crashlytics/Sentry installation UUIDs also fall here. |
| User Content → Photos or Videos | `NSPrivacyCollectedDataTypePhotosorVideos` | Camera capture only (`teacher_content_screen.dart`, `ImageSource.camera`). There is no photo-library access. |
| User Content → Other User Content | `NSPrivacyCollectedDataTypeOtherUserContent` | Uploaded files (`file_picker`), assignment and exam submissions, announcements, discipline incidents, attendance and grading entries, quiz attempts and flashcard reviews, AI questions, and AI content reports. |
| Diagnostics → Crash Data | `NSPrivacyCollectedDataTypeCrashData` | Crashlytics and Sentry, tagged with the user ID. |
| Diagnostics → Performance Data | `NSPrivacyCollectedDataTypePerformanceData` | Sentry performance monitoring. |
| Diagnostics → Other Diagnostic Data | `NSPrivacyCollectedDataTypeOtherDiagnosticData` | Device model, OS version, breadcrumbs (Sentry), and session-start events (FirebaseSessions). |

**Not collected.** Each of these was checked against the code:

- **Name and Phone Number.** The account holds the name the school entered, but the app never
  sends a name or phone number. The ID token's name claim is not stored. The API matches on `sub`
  only.
- **Payment Info and Purchase History.** Parents only *view* invoices and receipts that the API
  returns. Fees are paid on the school's page in the system browser, and nothing is bought in the
  app (`docs/store_payment_routing.md`). Displaying data the server already holds is not collection
  under either store's definition.
- **Location, Contacts, Health, Sensitive Info, Browsing or Search History, Audio.** There is no
  code path or permission for any of them. `file_picker`'s audio picker is compiled out (see
  [Native build](#native-build)).
- **Usage Data (Product Interaction, Advertising Data).** There is no analytics SDK. Firebase's
  own manifests list "Other Data" and "Other Diagnostic Data" for analytics. That is Google's
  internal service telemetry for FCM and installations. Studafy reads none of it, and it is covered
  by the Diagnostics answers above.

Why the app answers **Linked** while Firebase's and Sentry's own manifests say not linked: those
SDKs collect nothing identifying by default. This app links their data by calling
`setUserIdentifier` / `SentryUser` with the user ID. The app is responsible for the label.

## Play Console: Data safety

**Overview answers**

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | Yes |
| Is all of the user data collected by your app encrypted in transit? | Yes |
| Which ways do you provide for users to request that their data is deleted? | "My app provides a way for users to request that their data is deleted": in the app (Profile → Delete my account) and on the web |
| Delete account URL | `https://app.studafy.com/legal/delete-account` |
| Data deletion: can users request deletion of some data without deleting the account? | No. Per-item deletion is not offered, so leave the optional "data deletion" URL empty. |
| Independent security review | No |

**Data types.** Every type below is **collected**, **not shared** (Play does not count transfers to
service providers as sharing), and **not ephemeral**.

| Play category → type | Required or optional | Purposes | Same source as |
| --- | --- | --- | --- |
| Personal info → Email address | Required | App functionality, Account management | Email Address |
| Personal info → User IDs | Required | App functionality, Account management | User ID |
| Personal info → Other info | Required | App functionality | Education records a teacher enters: grades, attendance, discipline incidents |
| Photos and videos → Photos | Optional | App functionality | Photos or Videos |
| Files and docs → Files and docs | Optional | App functionality | Uploaded materials and submission attachments |
| Messages → Other in-app messages | Optional | App functionality | Class announcements |
| App activity → Other user-generated content | Optional | App functionality | Submissions, AI questions, AI content reports |
| App activity → Other actions | Optional | App functionality | Quiz attempts and flashcard reviews |
| App info and performance → Crash logs | Required | App functionality | Crash Data |
| App info and performance → Diagnostics | Required | App functionality | Performance Data, Other Diagnostic Data |
| Device or other IDs → Device or other IDs | Required | App functionality | Device ID |

"Required" means the user cannot turn it off. There is no crash-reporting opt-out. Push needs
the OS notification permission, but the Firebase Installation ID exists either way.

Anthropic receives AI inputs as a service provider, so this is not sharing on Play. ST-305's
consent screen is the disclosure Apple 5.1.2(i) needs.

**Target audience.** ST-307 concluded that Play's Families policy applies, because users' ages are
unknown until sign-in. Select the under-13 age groups under Target audience and content, and keep
these answers consistent with that.

## Deletion routes (ST-301 / ST-302)

| Route | Who can use it | What it does |
| --- | --- | --- |
| App → Profile → Delete my account | Signed-in user | Opens `/account/delete` in the system browser (`legal_links.dart`) |
| `/account/delete` | Signed-in user | `POST /api/account/deletion`: signs out everywhere, detaches from the school, stops AI billing, and files an erasure due in 30 days |
| `https://app.studafy.com/legal/delete-account` | Anyone, no app or sign-in | Emails a one-time link (`POST /api/account/deletion-requests`). Confirming it runs the same deletion |

Retained after erasure, as disclosed on the confirmation screen and in
`docs/modules/account-deletion.md`: grades and attendance with personal columns redacted,
financial records, and the audit log.

Data the deletion does **not** reach yet. Do not describe deletion as complete on either form until
these are closed:

- AI messages, submission text, and uploaded files in S3. These are ST-301's documented known gap.
- Crash and diagnostic events already sent to Sentry and Crashlytics. They expire with each
  vendor's retention period and are not deleted per user.

## Privacy policy URL

| Where | Value |
| --- | --- |
| App: login screen and Profile tab | `privacyPolicyUrlProvider` → `{webBaseUrl}/privacy`, which is `https://app.studafy.com/privacy` in prod, opened in the system browser |
| App Store Connect → Privacy Policy URL | `https://app.studafy.com/privacy` |
| Play Console → Store settings → Privacy policy | `https://app.studafy.com/privacy` |

The app and both listings use one URL, so a listing can never point somewhere the app does not.

## Privacy manifests

Apple requires a privacy manifest from the app and from each third-party SDK. The app's manifest
must cover any required-reason API called by code that ships without one.

**App: `ios/Runner/PrivacyInfo.xcprivacy`.** It is in the Runner target's Copy Bundle Resources
phase. It declares the data types above, no tracking, and two required-reason API types for SQLite,
which has no manifest of its own:

| API category | Reason | Why |
| --- | --- | --- |
| File timestamp | `C617.1` | SQLite calls `stat`, `fstat` and `lstat` on its database inside the app container |
| Disk space | `E174.1` | SQLite calls `statfs` and `fstatfs` on the volume holding that database before writing to it. Apple has no reason code for reading the filesystem type, which is also part of what SQLite does. `E174.1` is the nearest one. The values never leave the device |

These calls were read from the import table of the prebuilt `libsqlite3.arm64.ios.dylib` that
`sqlite3` 3.5.2 bundles (SHA-256 `f1bc69a4…6cc17991`, the value pinned in its `asset_hashes.dart`).
The `sqlite3` pod that `sqlite3_flutter_libs` adds is built from the same SQLite source.

**Flutter plugins (iOS, release build).**

| Plugin | Manifest | Required-reason APIs declared |
| --- | --- | --- |
| `app_links` | Own | None |
| `file_picker` | Own | None |
| `firebase_core` | None. Wrapper only: native code calls no required-reason API (checked) | Covered by the Firebase pods below |
| `firebase_crashlytics` | None. Wrapper only (checked) | Covered by the Firebase pods below |
| `firebase_messaging` | Own | UserDefaults `CA92.1` |
| `flutter_local_notifications` | Own | UserDefaults `CA92.1` |
| `flutter_pdfview` | Own | None |
| `flutter_secure_storage` | Own | None |
| `image_picker_ios` | Own | None |
| `package_info_plus` | Own | None |
| `path_provider_foundation` | No native target. Dart FFI through `objective_c`, calling only `NSFileManager` directory lookups | None needed |
| `sentry_flutter` | None. Wrapper only (checked) | Covered by the `Sentry` pod |
| `shared_preferences_foundation` | Own | UserDefaults `CA92.1` |
| `sqlite3_flutter_libs` | None | Covered by the app manifest |
| `url_launcher_ios` | Own | None |

`shared_preferences_foundation` ships in release: `easy_localization` depends on
`shared_preferences` to remember the chosen locale. `integration_test` is a dev dependency and is
not in the release build.

**Native SDKs pulled in by those plugins.**

| SDK | Manifest | Declares |
| --- | --- | --- |
| Flutter engine | Own | File timestamp `0A2A.1`, `C617.1`. System boot time `35F9.1` |
| FirebaseCore, FirebaseCoreInternal, FirebaseCoreExtension | Own | UserDefaults `CA92.1` (Core) |
| FirebaseCrashlytics | Own | Crash Data, Other Diagnostic Data. UserDefaults `CA92.1` |
| FirebaseMessaging | Own | Device ID, Other Data, Other Diagnostic Data |
| FirebaseInstallations | Own | Other Diagnostic Data |
| FirebaseSessions | **None upstream** (11.15.0) | Calls no required-reason API directly. UserDefaults goes through GoogleUtilities, and `sysctlbyname` reads `kern.osversion` only. Its session events are declared under Other Diagnostic Data above |
| FirebaseRemoteConfigInterop | None | Interface only, no implementation |
| GoogleUtilities, GoogleDataTransport, PromisesObjC, PromisesSwift, nanopb | Own | — |
| Sentry (`Sentry/HybridSDK` 8.46.0) | Own | Crash, Performance, Other Diagnostic Data. UserDefaults `CA92.1`, boot time `35F9.1`, file timestamp `C617.1` |
| sqlite3 (pod 3.52.0, and the `sqlite3` native asset) | None | Covered by the app manifest |

**Signatures.** Apple checks signatures on binary SDKs from its list of commonly used third-party
SDKs. In this build, every pod above, Firebase and Sentry included, is compiled from source and
signed with Studafy's distribution identity when the app is signed. There is no third-party binary
to check except these two:

- **`Flutter.xcframework`.** Run `codesign -dv --verbose=2` on it in the first macOS build.
- **The `sqlite3` dylib.** It is hash-pinned but unsigned upstream. Flutter wraps it in a framework
  that is signed with the app. It is not on Apple's list.

Xcode's Product → Archive → Generate Privacy Report shows the merged result. Attach that report to
the first submission's review notes.

## Native build

`ios/Podfile` is now committed. Before this, Flutter generated it at build time. It does two
things:

- **Sets `Pod::PICKER_MEDIA = false` and `Pod::PICKER_AUDIO = false`.** The app only calls
  `FilePicker.pickFiles` with the default `FileType.any`, which on iOS is the system document
  picker. Without these flags the build pulls in DKImagePickerController, DKPhotoGallery,
  SDWebImage and SwiftyGif. It would also reference Photos and MediaPlayer APIs, which need
  `NSPhotoLibraryUsageDescription` and `NSAppleMusicUsageDescription`, strings this app does not
  and should not declare.
- **Maps the dev, staging and prod build configurations to debug or release.** Without the
  mapping, CocoaPods treats every unknown configuration as release.

Android has no manifest equivalent. Its declarations are the Data safety form above and
`sdk_compliance_inventory.md`.

## Open items

1. **iOS has not been built with these changes.** The audit machine runs Windows, with no Xcode or
   CocoaPods. The first macOS build has to run `pod install`, archive, and generate the privacy
   report before submission.
2. **No URL in this mapping resolves yet.** On 2026-10-01, `app.studafy.com` had no DNS record.
   `studafy.com/privacy` redirects to `www.studafy.com`, a site that is not built from this repo:
   it returns HTTP 200 and the same landing page for any path, including made-up ones. Deploy
   `apps/web` to `app.studafy.com` before entering the URLs in either console. Then check that
   `/privacy` and `/legal/delete-account` render.
3. **Legal review of the privacy policy.** `PrivacyPolicyPage.tsx` previously said Studafy does
   not collect your email. That is false, so it was corrected in ST-308 to match the Email Address
   answer, and it now names Anthropic for the AI tools. It is still an engineer-drafted policy and
   needs legal sign-off before submission.
4. **Erasure gaps.** See [Deletion routes](#deletion-routes-st-301--st-302).
5. **Duplicate SQLite.** `sqlite3` 3.x bundles its own library, and `sqlite3_flutter_libs` (built
   for `sqlite3` 2.x) still adds a second copy through CocoaPods and Gradle. Its README marks it
   obsolete after the upgrade. Removing it needs a device build on both platforms, so it is not
   done here. The manifest covers both copies either way.
6. **Sentry IP storage and the Firebase data-processing terms** are console steps. See ST-307's
   open items 2 and 3.
