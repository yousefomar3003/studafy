import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/config/release_logging.dart';

/// QA-084: `debugPrint` writes to the device log (logcat / Console), which other tools on the
/// device and anyone with a cable can read. Realtime frames and push payloads went there in
/// release builds. Release builds silence it.
void main() {
  late DebugPrintCallback original;
  late List<String?> printed;

  setUp(() {
    original = debugPrint;
    printed = [];
    debugPrint = (message, {wrapWidth}) => printed.add(message);
  });
  tearDown(() => debugPrint = original);

  test('a release build drops every debugPrint', () {
    silenceDebugPrintInRelease(isRelease: true);

    debugPrint('realtime frame {"token":"secret"}');

    expect(printed, isEmpty);
  });

  test('a debug or profile build keeps debugPrint', () {
    silenceDebugPrintInRelease(isRelease: false);

    debugPrint('kept');

    expect(printed, ['kept']);
  });

  test('the default follows the build mode', () {
    silenceDebugPrintInRelease();

    debugPrint('kept under flutter test');

    // `flutter test` is never a release build.
    expect(printed, ['kept under flutter test']);
  });
}
