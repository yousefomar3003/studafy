# Performance & size pass — report (Studafy mobile)

This pass targeted four levers: faster startup (deferred work off the main isolate's start path),
60fps list scrolling (lazy list virtualization), a deliberate image-decode/cache policy, and a
hard binary-size budget enforced at release build time. All measurements use
`docs/perf-test-protocol.md`; **verified-by-me** means verified on this workstation, not on the
reference device.

## Environment / honesty first

- This machine has no `adb` and no Android device attached, and this is not the reference device.
  The two device workloads (cold start, 60fps scroll) are **pending on the reference device** and
  marked unverified here — I am not reporting invented numbers.
- Toolchain: Flutter `3.44.8`, Dart `3.12.2`, target `apps/mobile`.
- `flutter analyze --no-pub` (whole repo, pre-existing infos/warnings only) and the targeted test
  files listed per change are green.

## Changes

### 1. Defer startup work off the launch path

`lib/src/core/config/app_bootstrap.dart`, `lib/src/core/push/push_service.dart`,
`lib/src/core/monitoring/crashlytics_reporter.dart`.

- Before: `Firebase.initializeApp()`, FCM background-handler registration, and
  `crashReporter.initialize()` all ran before `runApp` on the isolate's warm-up burst, and
  constructing `FirebasePushService` touched Firebase (starting SDKS without a running app).
- After: those three are moved to a `post-frame` `_deferredSetup()` (first frame already painted),
  gated so nothing wrapped in them is needed for the login screen. `FirebasePushService` now
  resolves `_messaging`/`_localNotifications` lazily through `_ensureFirebase()`, and
  `CrashlyticsReporter` no-ops until `initialize()` (no "used before initialized" reports during
  the deferred window). `EasyLocalization`, date formatting, `PackageInfo`, and the
  auth-session restore stay pre-`runApp` — they don't blink locale/theme/auth state.
- Tests: `push_service_test.dart` green (constructor + register flow no longer touches Firebase
  before init).

### 2. Lazy roster/attendance lists (60fps)

- `lib/src/features/teacher/presentation/teacher_class_detail_screen.dart`: the roster tab was a
  `ListView(children: Column)` building every tile up front. Now a `CustomScrollView` with a small
  header sliver + `SliverList.builder` roster (per-viewport lazy). Backed by
  `integration_test/perf_list_jank_test.dart` to guard the regression.
- `lib/src/features/teacher/presentation/attendance_taking_screen.dart`: taking + recorded rosters
  were eager too; both are `ListView.builder`. Taking partition is an index over
  `lockedCount + editable.length` (same ordering as before).
- `lib/src/features/student/presentation/grades_screen.dart`: was converted, then **reverted**. The
  grade deep-link highlight (`Scrollable.ensureVisible` on `_highlightKey`) needs every card
  materialized, and subjects are bounded (5–10). Eager is the correct choice here; a comment
  documents why.
- `lib/src/features/student/presentation/widgets/today_assignments_card.dart`: assignments capped at
  `maxItems: 5` (mirrors the announcements card); no unbounded daily list.
- Tests: `teacher_class_detail_screen_test.dart`, `attendance_taking_screen_test.dart` green.

### 3. Image decode/cache policy

- `lib/src/features/student/presentation/material_viewer_screen.dart` is the app's only `Image`:
  `Image.file`. It now decodes at `cacheWidth: (screenWidth × devicePixelRatio).ceil()` instead of
  the file's full-res bitmap, and `MaterialFileCache` already disk-caches the file — no network
  images exist in the app, so **no new dependency** (e.g. `cached_network_image`) was added (KISS).
- The rule going forward: decode to screen resolution at the `Image` call site; rely on the
  existing file cache; re-visit only if a network image source is added.

### 4. Size budget (40 MB / platform) + release-lane gate

- Definition (your call): measurement is the **largest per-ABI split APK** for Android (what a
  device actually downloads) and the **.ipa** for iOS.
- `fastlane/Fastfile`: `SIZE_BUDGET_MB = 40`. `enforce_size_budget!` fails the lane over budget,
  prints a size table, and mirrors it to the CI step summary. Android gates `internal`/`release`
  via `enforce_android_size_budget!` (`flutter build apk --release --flavor prod --split-per-abi`,
  then checks each split); iOS gates `build_ios_ipa`. Both are defined in
  docs/perf-test-protocol.md §3.

## Verdicts (from the protocol's results table)

| Workload | Budget | Result | Verdict |
| --- | --- | --- | --- |
| Cold start, median (reference spec) | ≤ 2.5 s | _pending_ — no reference device here | unverified |
| Roster scroll avg/p90, 60 rows | < 16.7 ms | _pending_ — harness ready (`integration_test/perf_list_jank_test.dart`) | unverified |
| Largest per-ABI APK | ≤ 40 MB | _pending_ — release build not yet run | unverified |
| iOS .ipa | ≤ 40 MB | _pending_ — requires Apple toolchain | unverified |

Everything under the gate is implemented, analyzed, and can be run; only the device/build runs are
outstanding.

## Knowns / levers if a future build goes over budget

- Current APK size drivers (unverified, from the manifest/deps): the Firebase + Sentry plugin set,
  and native code for ABI splits. `flutter deps` shows the full tree; the size table at build time
  will confirm which ABI is worst.
- Levers, in order of effort: drop `x86_64`/a split-ABI list in `build.gradle.kts` splits
  (emulator-only, no install base); `--split-debug-info` + symbols upload; R8 shrinking; audit
  replacement of a plugin (e.g. if `firebase_in_app_messaging` is unused); move heavy native deps
  into a dynamic-feature module (last resort).
- Cold-start numbers degrade first with the deferred init if the login screen gains dependency on
  any moved work — the `_deferredSetup()` boundary is the single seam this pass established for
  that trade-off.