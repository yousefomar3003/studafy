import 'package:intl/date_symbol_data_local.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';

/// Mirrors `app_bootstrap.dart`'s own `initializeDateFormatting` loop, which production runs
/// once at startup. Widget tests that pump a screen using `DateFormat` (e.g. `TodayAssignmentsCard`)
/// never run that bootstrap path, so they need this called once — a `setUpAll` in the test file
/// is the right place, since `initializeDateFormatting` is safe to call more than once but is
/// pointless to repeat before every single test.
Future<void> ensureDateFormattingInitialized() async {
  for (final locale in AppLocales.supported) {
    await initializeDateFormatting(locale.toString());
  }
}
