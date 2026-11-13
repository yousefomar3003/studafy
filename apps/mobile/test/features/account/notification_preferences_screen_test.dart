import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_preference.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_preference_channel.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_preference_notification_type.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_preferences.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_quiet_hours.dart';
import 'package:studafy_mobile/src/core/push/push_providers.dart';
import 'package:studafy_mobile/src/core/push/push_service.dart';
import 'package:studafy_mobile/src/features/account/application/account_settings_providers.dart';
import 'package:studafy_mobile/src/features/account/presentation/notification_preferences_screen.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';

import '../../support/fake_push_service.dart';
import 'account_test_app.dart';

NotificationPreference _cell(
  NotificationPreferenceNotificationType type,
  NotificationPreferenceChannel channel, {
  bool enabled = true,
  bool mandatory = false,
}) => NotificationPreference(
  notificationType: type,
  channel: channel,
  enabled: enabled,
  digest: false,
  mandatory: mandatory,
  digestEligible: false,
);

NotificationPreferences _matrix({bool gradesPush = true}) {
  const push = NotificationPreferenceChannel.push;
  const email = NotificationPreferenceChannel.email;
  const inApp = NotificationPreferenceChannel.inApp;
  return NotificationPreferences(
    attendanceAlertThreshold: 3,
    preferences: [
      _cell(
        NotificationPreferenceNotificationType.gradePosted,
        push,
        enabled: gradesPush,
      ),
      _cell(
        NotificationPreferenceNotificationType.assignmentGraded,
        push,
        enabled: gradesPush,
      ),
      _cell(NotificationPreferenceNotificationType.gradePosted, email),
      _cell(NotificationPreferenceNotificationType.gradePosted, inApp),
      _cell(
        NotificationPreferenceNotificationType.adminAnnouncement,
        push,
        mandatory: true,
      ),
      _cell(NotificationPreferenceNotificationType.feeInvoiceIssued, push),
      _cell(NotificationPreferenceNotificationType.materialIngested, push),
      _cell(NotificationPreferenceNotificationType.attendanceAlert, push),
    ],
  );
}

Widget _app({
  required List<String> roles,
  List<List<PreferenceChange>>? saved,
  PushPermission permission = PushPermission.granted,
  FakePushService? push,
  List<(String?, String?)>? quietSaves,
  void Function()? onTest,
}) {
  final pushService = push ?? FakePushService();
  return ProviderScope(
    overrides: [
      sessionRolesProvider.overrideWithValue(roles),
      pushServiceProvider.overrideWithValue(pushService),
      pushPermissionProvider.overrideWith((ref) async => permission),
      accountNotificationPreferencesProvider.overrideWith(
        (ref) async => _matrix(),
      ),
      updateNotificationPreferencesProvider.overrideWithValue((changes) async {
        saved?.add(changes);
        return _matrix(gradesPush: false);
      }),
      notificationQuietHoursProvider.overrideWith(
        (ref) async => const NotificationQuietHours(
          start: null,
          end: null,
          timezone: 'Asia/Amman',
        ),
      ),
      updateQuietHoursProvider.overrideWithValue((start, end) async {
        quietSaves?.add((start, end));
        return NotificationQuietHours(
          start: start,
          end: end,
          timezone: 'Asia/Amman',
        );
      }),
      sendTestNotificationProvider.overrideWithValue(
        () async => onTest?.call(),
      ),
    ],
    child: accountScreenApp(const NotificationPreferencesScreen()),
  );
}

Switch _switch(WidgetTester tester, String key) =>
    tester.widget<Switch>(find.byKey(Key('notificationPref-$key')));

void main() {
  test('groups server notification types into the kinds people recognise', () {
    expect(notificationCategoryOf('GRADE_POSTED'), NotificationCategory.grades);
    expect(
      notificationCategoryOf('ASSIGNMENT_GRADED'),
      NotificationCategory.grades,
    );
    expect(
      notificationCategoryOf('ASSIGNMENT_PUBLISHED'),
      NotificationCategory.assignments,
    );
    expect(
      notificationCategoryOf('DIRECT_MESSAGE'),
      NotificationCategory.messages,
    );
    expect(
      notificationCategoryOf('ATTENDANCE_MARKED'),
      NotificationCategory.attendance,
    );
    expect(
      notificationCategoryOf('FEE_PAYMENT_REMINDER'),
      NotificationCategory.fees,
    );
    expect(
      notificationCategoryOf('LICENSE_INVOICE_DUE'),
      NotificationCategory.fees,
    );
    expect(
      notificationCategoryOf('ENROLLMENT_APPROVED'),
      NotificationCategory.schoolUpdates,
    );
  });

  testWidgets('one switch turns off every type in the kind, in a single save', (
    tester,
  ) async {
    final saved = <List<PreferenceChange>>[];
    await pumpAccountScreen(
      tester,
      _app(roles: const ['STUDENT'], saved: saved),
    );

    expect(find.text('Marks'), findsOneWidget);
    expect(_switch(tester, 'grades/push').value, isTrue);

    await tester.tap(find.byKey(const Key('notificationPref-grades/push')));
    await tester.pumpAndSettle();

    expect(saved, hasLength(1));
    expect(saved.single.map((change) => change.type).toSet(), {
      'GRADE_POSTED',
      'ASSIGNMENT_GRADED',
    });
    expect(saved.single.every((change) => change.channel == 'push'), isTrue);
    expect(saved.single.every((change) => !change.enabled), isTrue);
    expect(_switch(tester, 'grades/push').value, isFalse);
  });

  testWidgets('a kind the school requires is locked on', (tester) async {
    await pumpAccountScreen(tester, _app(roles: const ['PARENT']));

    expect(find.text('Required by your school'), findsOneWidget);
    expect(_switch(tester, 'announcements/push').onChanged, isNull);
  });

  testWidgets('kinds follow the role', (tester) async {
    await pumpAccountScreen(tester, _app(roles: const ['STUDENT']));
    expect(find.text('Fees and billing'), findsNothing);
    expect(find.text('Attendance'), findsOneWidget);

    await pumpAccountScreen(tester, _app(roles: const ['PARENT']));
    expect(find.text('Fees and billing'), findsOneWidget);
  });

  testWidgets('allowed: sends a test notification', (tester) async {
    var tests = 0;
    await pumpAccountScreen(
      tester,
      _app(roles: const ['STUDENT'], onTest: () => tests++),
    );

    await tester.tap(find.byKey(const Key('notificationSendTest')));
    await tester.pumpAndSettle();

    expect(tests, 1);
    expect(find.textContaining('Sent.'), findsOneWidget);
  });

  testWidgets('turned off in the phone: offers Settings', (tester) async {
    final push = FakePushService();
    await pumpAccountScreen(
      tester,
      _app(
        roles: const ['STUDENT'],
        permission: PushPermission.denied,
        push: push,
      ),
    );

    expect(find.byKey(const Key('notificationSendTest')), findsNothing);
    await tester.tap(find.byKey(const Key('notificationOpenSettings')));
    await tester.pumpAndSettle();
    expect(push.settingsOpened, 1);
  });

  testWidgets('never asked: offers to turn notifications on', (tester) async {
    final push = FakePushService(permissionUnanswered: true);
    await pumpAccountScreen(
      tester,
      _app(
        roles: const ['STUDENT'],
        permission: PushPermission.notDetermined,
        push: push,
      ),
    );

    await tester.tap(find.byKey(const Key('notificationTurnOn')));
    await tester.pumpAndSettle();
    expect(push.permissionRequests, 1);
  });

  testWidgets('quiet hours turn on with a default window and turn off', (
    tester,
  ) async {
    final saves = <(String?, String?)>[];
    await pumpAccountScreen(
      tester,
      _app(roles: const ['STUDENT'], quietSaves: saves),
    );

    await tester.ensureVisible(find.byKey(const Key('notificationQuietHours')));
    await tester.tap(find.byKey(const Key('notificationQuietHours')));
    await tester.pumpAndSettle();
    expect(saves.last, ('22:00', '07:00'));
    expect(find.text('22:00'), findsOneWidget);
    expect(find.text('07:00'), findsOneWidget);

    await tester.tap(find.byKey(const Key('notificationQuietHours')));
    await tester.pumpAndSettle();
    expect(saves.last, (null, null));
  });
}
