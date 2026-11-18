import 'package:flutter/foundation.dart';

/// Turns [debugPrint] into a no-op in release builds (QA-084).
///
/// `debugPrint` is not stripped from release builds: it writes to the device log (logcat on
/// Android, the unified log on iOS), which other tools and anyone with a cable can read. Call
/// sites print realtime frames and push-registration errors, which can carry ids and tokens.
/// Errors that matter in production go to the crash reporter instead.
///
/// [isRelease] is for tests; the app passes nothing.
void silenceDebugPrintInRelease({bool isRelease = kReleaseMode}) {
  if (isRelease) debugPrint = _discard;
}

void _discard(String? message, {int? wrapWidth}) {}
