import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_notifier.dart';
import '../auth/auth_state.dart';
import 'crash_reporter.dart';

/// Overridden at bootstrap with the real [CrashReporter] built in `app_bootstrap.dart` — see
/// `appConfigProvider` for the same pattern and its rationale.
final crashReporterProvider = Provider<CrashReporter>((ref) {
  throw StateError('CrashReporter must be provided during app bootstrap.');
});

/// Keeps the crash reporter's identified user in sync with auth state: the user id (never an
/// email or name) is attached on login and cleared on logout, so a crash report can be
/// correlated to a session without carrying PII.
///
/// Read once, for its side effect, from `StudafyApp` — the same activation pattern
/// `pushInitProvider` uses. Not `autoDispose`: it must keep listening for the app's lifetime.
final crashReportingUserSyncProvider = Provider<void>((ref) {
  void sync(AuthStatus status) {
    final crashReporter = ref.read(crashReporterProvider);
    final session = ref.read(authSessionProvider);
    crashReporter.identifyUser(status == AuthStatus.authenticated ? session.userId : null);
  }

  ref.listen(authStatusProvider, (previous, next) => sync(next), fireImmediately: true);
});
