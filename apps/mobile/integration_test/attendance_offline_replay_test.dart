import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:studafy_mobile/src/features/teacher/application/attendance_sync_queue.dart';

import 'support/api_helpers.dart';
import 'support/personas.dart';
import 'support/test_app.dart';

/// Journey 3/5 (ST-247): attendance offline replay.
///
/// Real UI, real `OfflineDatabase`/`AttendanceSyncQueue` code paths throughout. "Offline" is
/// simulated by repointing the app's own API base URL at an unroutable host
/// (`IntegrationTestApp.setApiBaseUrl` — see its doc comment for why an instrumented test cannot
/// reach the device's OS-level airplane-mode toggle) rather than a physical radio, but the
/// resulting `DioException` (connection refused, no response) is a genuine network failure, and
/// `AttendanceSyncQueue._classifyFailure` genuinely cannot distinguish it from real airplane mode
/// — both present as "no response at all". Everything after that — enqueueing, the offline
/// snackbar, the outbox row, the retry, the real server accepting the replayed submission — is
/// the unmodified production code path.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('holds a submission in the outbox while offline and replays it on retry', (
    tester,
  ) async {
    final app = await IntegrationTestApp.pump(tester, mockLoginHint: Personas.scienceTeacher);
    await app.signInWithMock(tester);

    // Confirm the class this run will submit for has no register already sitting in the outbox
    // from a previous failed run — a stale entry would short-circuit the real submit path.
    final dio = Dio(BaseOptions(baseUrl: app.appConfig.apiBaseUrl.toString()));
    final teacherToken = await apiLoginAs(dio, Personas.scienceTeacher);
    final scienceClass = await resolveScienceClass(dio, teacherToken);

    await tester.tap(find.text('Classes'));
    await tester.pumpAndSettle();

    await tester.tap(find.text(scienceClassCode));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Take attendance'));
    await tester.pumpAndSettle();

    final queue = app.container.read(attendanceSyncQueueProvider);
    final preexisting = await queue.pendingFor(classId: scienceClass.id, period: null);
    if (preexisting != null) {
      fail(
        'a register for ${scienceClass.id} is already queued from a previous run — clear the '
        "app's local storage (uninstall/reinstall) before re-running this suite",
      );
    }

    // Go offline: every editable roster row defaults to "present" (see
    // `_AttendanceTakingScreenState._reconcileDraft`), so submitting now is enough to exercise the
    // failure path with no roster interaction needed.
    app.setApiBaseUrl(Uri.parse('http://127.0.0.1:1'));

    await tester.tap(find.text('Submit attendance'));
    await pumpUntil(tester, () => find.text('Retry now').evaluate().isNotEmpty);

    expect(
      find.text("Saved on this device — it will sync when you're back online."),
      findsOneWidget,
    );
    final queuedAfterOffline = await queue.pendingFor(classId: scienceClass.id, period: null);
    expect(queuedAfterOffline, isNotNull, reason: 'submission should be queued in the outbox');

    // Back online: retry should reach the real server and clear the outbox. `dio` was built from
    // the real reachable URL before `setApiBaseUrl` above pointed the app itself at the unroutable
    // one, so its own `baseUrl` is untouched and still the right value to restore.
    app.setApiBaseUrl(Uri.parse(dio.options.baseUrl));

    await tester.tap(find.text('Retry now'));
    await pumpUntil(tester, () => find.text('Attendance submitted.').evaluate().isNotEmpty);

    final queuedAfterRetry = await queue.pendingFor(classId: scienceClass.id, period: null);
    expect(queuedAfterRetry, isNull, reason: 'a successful replay must clear the outbox entry');
  });
}
