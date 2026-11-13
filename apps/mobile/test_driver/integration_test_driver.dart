import 'package:integration_test/integration_test_driver.dart';

/// Driver for `flutter drive` — the standard `integrationDriver()` main. Present only so the
/// profile-mode perf harness (`integration_test/perf_list_jank_test.dart`) can be run:
///
///   flutter drive --profile \
///     --driver=test_driver/integration_test_driver.dart \
///     --target=integration_test/perf_list_jank_test.dart
///
/// See docs/perf-test-protocol.md §2. Regular CI integration runs use `flutter test
/// integration_test/` on the test lab and do not go through this file.
Future<void> main() => integrationDriver();