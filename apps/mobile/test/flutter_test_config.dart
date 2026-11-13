import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';

/// Global test bootstrap, picked up automatically by `flutter test`.
///
/// `AppTypography` loads Inter via `google_fonts`, asynchronously, the first time each weight
/// is requested. Without this, the first golden pump in a test file can race that load and
/// render with the fallback font while a later pump in the same run renders with Inter — a
/// flaky, order-dependent golden. Building both themes once up front and awaiting every font
/// they requested makes font loading deterministic before any test body runs.
///
/// `flutter test` also blocks real HTTP requests (`TestWidgetsFlutterBinding` returns 400 for
/// any `HttpClient` call), so this only works because Inter is bundled as an asset
/// (`assets/fonts/`, declared in `pubspec.yaml`) and `allowRuntimeFetching` is off — the same
/// asset-first path `bootstrapApp` uses for the shipped app.
///
/// `EasyLocalization.ensureInitialized()` reads a persisted locale via `shared_preferences`
/// regardless of whether a given test cares about persistence, so every test file needs a
/// working (mocked) preferences store before it runs — same requirement `bootstrapApp` has on
/// a real device, just backed by memory instead of platform storage here.
///
/// `rootBundle.clear()` after each test works around a known `easy_localization`/`flutter_test`
/// interaction: `RootBundleAssetLoader` loads translation JSON through `rootBundle`, which
/// caches asset strings for the lifetime of the binding rather than per test. A second
/// `EasyLocalization` mounted in the same test file can hang forever waiting on a load that
/// never resolves against that stale cache — see
/// https://github.com/aissat/easy_localization/issues/268 — silently leaving `Localizations`
/// stuck rendering an empty `SizedBox.shrink()` for every widget test after the first.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  TestWidgetsFlutterBinding.ensureInitialized();
  GoogleFonts.config.allowRuntimeFetching = false;
  SharedPreferences.setMockInitialValues({});
  await EasyLocalization.ensureInitialized();

  setUpAll(() async {
    AppTheme.light;
    AppTheme.dark;
    await GoogleFonts.pendingFonts();
  });

  tearDown(() {
    rootBundle.clear();
  });

  await testMain();
}
