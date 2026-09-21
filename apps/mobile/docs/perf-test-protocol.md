# Performance test protocol (Studafy mobile)

The single source of truth for measuring Studafy's startup, scroll, and size performance on a
physical device. Every number in `docs/perf-pass-report.md` must be produced by a method described
here; if you measure differently, the number is not comparable and cannot be quoted as "the"
result.

Scope: Android only for device measurements. iOS is built and gated for size, but the reference-device
criterion is an Android-device criterion.

## Reference device

Pinned to a generic low-end spec so results are honest for the weakest devices we claim to support.
This is the budget-device class a student in a low-bandwidth market actually buys (Studafy is built
for low-end Android first — see `docs/ai_store_compliance.md`).

| Property | Reference spec |
| --- | --- |
| RAM | 2 GB |
| Android | 10 (Go-ish class; no heavy OEM skinning) |
| CPU | Quad-core, ~1.8 GHz (entry-level SoC, e.g. Snapdragon 4xx / Helio G25 class) |
| Screen | 720p (1280×720) |
| Storage | 32 GB eMMC |

Suggested concrete devices to borrow/buy when picking a physical unit (all satisfy the spec):

- Samsung Galaxy A02s (2 GB variant) — the current best existing-market match
- Redmi 9A / Redmi 10A
- Moto E7 plus (2 GB variant)
- Pixel 3a — NOT low-end, but the cheapest class A/B/AB-only device; the HDR/full-frame-precision
  raster path it enables can mask low-end raster cost, so prefer the above when possible

If the measured device differs from this spec, record it in the "Environment" row of the results
table. Do not silently substitute a flagship; a flagship pass is worth nothing as evidence.

## Environment rules (every measurement)

Pin these on the device before measuring; they move cold-start numbers by millions of microseconds.

- Airplane mode ON, then re-enable WiFi only if the workload needs the network (it does for cold
  start into the app — login is online). For scroll workloads run with network ON but WiFi quality
  is irrelevant (no images are network-loaded).
- Disable: lockscreen animations, "Charging sounds", Adaptive brightness, Always-on display.
- Remove the app icon from any launcher widget that shadows (optional; use `pm disable-user`) — the
  cold-start command below handles the shadow itself via `-W`.
- Charge ≥ 30%, and do not measure while charging (charging throttles the thermal envelope).
- Set brightness to ~50% and auto-brightness OFF.
- Start measuring after a `adb reboot` + 60 s settle, and after the device is otherwise idle (no
  other apps in foreground, notifications suppressed on the test APK — the prod flavor suppresses
  them for the measured variants anyway).
- Do not measure an app that was in Recents; always cold-launch through the exact command below.

## Workloads and methods

### 1. Cold start (time-to-display)

On a cold device (per the rules above), with a fresh profile build installed:

```
adb shell am start -W -n <package>/.MainActivity | grep -E "TotalTime|WaitTime"
```

- Record `TotalTime`. `WaitTime` includes launcher shadow and is a secondary number only.
- 5 runs, discard the first (JIT warm-up / package-manager cold path), report median and worst of
  the remaining 4.
- Budget: **median ≤ 2.5 s**.

### 2. List scroll jank (60fps)

Runnable harness: `integration_test/perf_list_jank_test.dart` scrolls a 60-student class roster
through `IntegrationTestWidgetsFlutterBinding.watchPerformance` and asserts the average and p90
build+raster stay under 16.7 ms. Run it in profile:

```
flutter drive --profile \
  --driver=test_driver/integration_test_driver.dart \
  --target=integration_test/perf_list_jank_test.dart
```

- Add `test_driver/integration_test_driver.dart` (one file, standard `integrationDriver()` main) if
  it is not already present.
- Record the printed numbers: frame count, avg build+raster, p90 total, missed-budget count, worst
  build, worst raster.
- Manual cross-check (optional, but the protocol number is the harness): drive the Teacher app to
  the same 60-student class in a `--profile` build, enable the DevTools performance timeline, fling
  through the roster 5×, read avg/p99 frame build from the timeline.
- Budget: **avg and p90 (build+raster) < 16.7 ms**, ≥ 4 distinct flings, 60 rows.
- rosters > 60 exist; the harness caps at 60 as the design target. A class known to be larger
  (e.g. 120) can be profiled manually with DevTools — record the size in the table.

### 3. Binary size

No device needed. Compute from the built artifacts:

- Android: `flutter build apk --release --flavor prod --split-per-abi`, then per-ABI artifact sizes:
  `list -l build/app/outputs/apk/prodRelease/` (Windows: `Get-ChildItem -Recurse | Select Length`).
- Gate: **largest per-ABI APK ≤ 40 MB** (`SIZE_BUDGET_MB` in `fastlane/Fastfile`, enforced on the
  `internal`/`release` lanes, mirrored to the CI step summary).
- iOS: `flutter build ipa --release --flavor prod`, then the `.ipa` under `build/ios/ipa/` — same
  40 MB budget in `build_ios_ipa`.

## Results table (fill per pass)

| Workload | Method ref | Budget | Result | Device noted? | Verdict |
| --- | --- | --- | --- | --- | --- |
| Cold start, median | §1 | ≤ 2.5 s | _pending_ | spec match required | _unverified_ |
| Roster scroll avg/p90 (60 rows) | §2 | < 16.7 ms | _pending_ | spec match required | _unverified_ |
| Largest per-ABI APK | §3 | ≤ 40 MB | _pending_ | n/a | _unverified_ |
| IOS .ipa | §3 | ≤ 40 MB | _pending_ | n/a | _unverified_ |

Never fill "Result" with an estimate. Leave `_pending_` or note "blocked: no reference device
available" rather than invent a number.

## When to run

- Release-blocking: every `mobile-v*` tag (fastlane already gates size at build time; the two
  device workloads are manual and recorded in the report before tagging).
- Also run when a change touches startup (`app_bootstrap.dart`), list rendering, image decoding, or
  adds a plugin with native code (size).