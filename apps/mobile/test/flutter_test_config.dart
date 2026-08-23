import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
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
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  TestWidgetsFlutterBinding.ensureInitialized();
  GoogleFonts.config.allowRuntimeFetching = false;

  setUpAll(() async {
    AppTheme.light;
    AppTheme.dark;
    await GoogleFonts.pendingFonts();
  });

  await testMain();
}
