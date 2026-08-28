# Crash and error monitoring

This covers `lib/src/core/monitoring` — the Sentry Flutter + Firebase Crashlytics wiring that
reports uncaught errors, tracks release health, and attaches a user id (never PII) to reports.

## Architecture

One interface, two vendor implementations, fanned out by a composite:

- `CrashReporter` (`crash_reporter.dart`) — the seam. `initialize`, `identifyUser`,
  `addBreadcrumb`, `recordError`, `recordFlutterError`. Nothing outside this directory imports
  `sentry_flutter` or `firebase_crashlytics` directly.
- `SentryCrashReporter` (`sentry_reporter.dart`) — Sentry. Enables session tracking (the
  "crash-free sessions" release-health metric), sets `release`/`environment` for symbolication,
  and scrubs PII in Sentry's own `beforeSend`/`beforeBreadcrumb` hooks (covers data the Sentry SDK
  collects on its own, e.g. lifecycle breadcrumbs).
- `FirebaseCrashlyticsReporter` (`crashlytics_reporter.dart`) — Crashlytics. No `beforeSend` hook
  exists on this vendor, so it only ever receives already-scrubbed data (from the composite) plus
  a defensive scrub of the two free-text fields it owns directly.
- `CompositeCrashReporter` (`composite_crash_reporter.dart`) — what `crashReporterProvider`
  actually holds. Scrubs PII once via `PiiScrubber` and fans every call out to both vendors. A
  vendor throwing is swallowed there — one backend being down must never block the other or
  crash the crash reporter itself.
- `PiiScrubber` (`pii_scrubber.dart`) — pure functions, no vendor dependency. Redacts a
  denylist of sensitive keys (`password`, `token`, `authorization`, `email`, ...) from structured
  data and inline email addresses from free text. Both scrub points above share this one instance.

Wiring lives in `app_bootstrap.dart`: both reporters are built and `initialize()`d before
`runApp`, then `FlutterError.onError`, `PlatformDispatcher.instance.onError`, and an outer
`runZonedGuarded` all route into the same `CompositeCrashReporter` — every error class Flutter can
produce reaches both vendors through one path.

**User identity is id-only.** `AuthSession.userId` (`auth_session.dart`) decodes the JWT's `sub`
claim — nothing else is read out of the token for this purpose. `crashReportingUserSyncProvider`
(`monitoring_providers.dart`) watches auth status and calls `identifyUser(session.userId)` on
login, `identifyUser(null)` on logout. Neither vendor SDK is ever given an email, name, or IP:
Sentry has `sendDefaultPii = false` set explicitly, and Crashlytics' `setUserIdentifier` is the
only identity call made to it.

## Configuration

`MonitoringConfig.fromEnvironment` (`monitoring_config.dart`) reads `SENTRY_DSN` via
`--dart-define`, the same pattern `AppConfig` already uses for `API_BASE_URL`. No DSN is
committed. With an empty DSN (the default — nothing is defined for local `flutter run` or `flutter
test`), `SentryCrashReporter` is a deliberate no-op: it still satisfies the `CrashReporter`
interface but never calls the Sentry SDK. Firebase Crashlytics has no equivalent DSN — it's gated
by whatever Firebase project `google-services.json`/`GoogleService-Info.plist` points at.

To point a build at a real Sentry project:

```
flutter run --dart-define=SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>
```

## What still needs a human with real credentials

Everything above compiles and is unit-tested without needing a live DSN or Firebase project — but
three things this ticket's acceptance criteria depend on need infrastructure I don't have access
to from here, and I want to be upfront that I have not verified them end-to-end:

1. **A real Sentry DSN and Firebase project.** Neither `google-services.json`
   (`android/app/`) nor `GoogleService-Info.plist` (`ios/Runner/`) is present in this repo — that
   was already true before this change (Firebase Messaging has the same dependency), so it's not a
   new gap, but it does mean crash reports have nowhere real to land yet.
2. **Android release symbolication.** `com.google.firebase.crashlytics` is now applied in
   `android/app/build.gradle.kts` (classpath pinned to `3.0.8` in the root `build.gradle.kts` —
   the current version on Google's Maven repo as of this writing; bump it if Gradle ever flags an
   incompatibility, I could not run a Gradle build to confirm it against this project's AGP 9.0.1
   toolchain). That plugin auto-uploads the ProGuard/R8 mapping file on release builds once
   Crashlytics is otherwise configured — no extra step needed beyond the `google-services.json`
   above.

   Sentry's own Android Gradle plugin (for uploading its ProGuard mapping and native symbols) is
   **not** wired. Unlike Crashlytics', that plugin needs a real Sentry org/project/auth token at
   apply time — wiring it against a project that doesn't exist yet risks breaking `flutter build
   apk --release` for everyone. Once a Sentry project exists, add it via `sentry_dart_plugin`
   (`dart pub add --dev sentry_dart_plugin`, configure `sentry:` in `pubspec.yaml`, run `dart run
   sentry_dart_plugin` as a release step) rather than the raw Gradle plugin — that's the
   Flutter-idiomatic path and keeps org/project/token out of the Gradle files entirely.
3. **iOS symbolication.** This repo has no `ios/Podfile` yet (Flutter generates one on first
   `pod install`/`flutter build ios` — iOS isn't set up here at all yet, independent of
   monitoring). Once it is, dSYM upload needs an Xcode Run Script build phase calling `sentry-cli`
   (for Sentry) and Crashlytics' own upload-symbols script — both are one-time, UI-driven Xcode
   project edits per each vendor's Flutter setup guide. Hand-editing `project.pbxproj` blind isn't
   something I'll do — it's easy to corrupt and there's nothing to test it against yet.

None of the above blocks local development or the test suite; they're what's left before a crash
in a real build reaches a real dashboard.

## Verifying the three acceptance criteria

Once a DSN and `google-services.json`/`GoogleService-Info.plist` are in place:

- **"Test crash appears with symbolication."** `crash_reporter.dart` exports
  `triggerTestCrash()` — it just throws. Wire it to a temporary debug affordance (a button, or a
  DevTools expression eval), run a **release** build (so ProGuard/dSYM stripping is actually
  exercised — a debug build won't tell you anything about symbolication), trigger it, and confirm
  both the Sentry issue and the Crashlytics crash show readable Dart method names, not addresses.
- **"Crash-free sessions metric visible."** Sentry only — Crashlytics' equivalent is
  "crash-free users %", a different metric name in a different dashboard tab. Requires a handful
  of real sessions (just opening and using the app) hitting the DSN above; Sentry's Releases page
  shows crash-free-sessions once any exist for that release.
- **"PII scrub verified."** `test/core/monitoring/pii_scrubber_test.dart` and
  `composite_crash_reporter_test.dart` cover the scrub logic and its wiring at the fan-out
  boundary directly. For the SDK-level hooks (`beforeSend`/`beforeBreadcrumb` on the Sentry side),
  the one thing a unit test can't reach is the real Sentry SDK's own auto-collected data — spot
  check that by triggering a real event against a dev DSN and inspecting the event payload in the
  Sentry UI for anything not on the redaction list in `pii_scrubber.dart`.
