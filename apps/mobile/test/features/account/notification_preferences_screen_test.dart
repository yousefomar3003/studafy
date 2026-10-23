import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_preference.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_preference_channel.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_preference_notification_type.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_preference_update.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_preference_update_channel.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_preference_update_notification_type.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_preferences.dart';
import 'package:studafy_mobile/src/features/account/application/account_settings_providers.dart';
import 'package:studafy_mobile/src/features/account/presentation/notification_preferences_screen.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';

import 'account_test_app.dart';

NotificationPreferences _matrix({bool gradePush = true}) {
  NotificationPreference cell(
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

  return NotificationPreferences(
    attendanceAlertThreshold: null,
    preferences: [
      // Deliberately out of channel order: the screen sorts in-app, push, email.
      cell(
        NotificationPreferenceNotificationType.gradePosted,
        NotificationPreferenceChannel.email,
      ),
      cell(
        NotificationPreferenceNotificationType.gradePosted,
        NotificationPreferenceChannel.push,
        enabled: gradePush,
      ),
      cell(
        NotificationPreferenceNotificationType.gradePosted,
        NotificationPreferenceChannel.inApp,
      ),
      cell(
        NotificationPreferenceNotificationType.adminAnnouncement,
        NotificationPreferenceChannel.inApp,
        mandatory: true,
      ),
      cell(
        NotificationPreferenceNotificationType.materialIngested,
        NotificationPreferenceChannel.push,
      ),
    ],
  );
}

Widget _app({
  required List<String> roles,
  required Future<NotificationPreferences> Function(
    NotificationPreferenceUpdate,
  )
  update,
}) {
  return ProviderScope(
    overrides: [
      sessionRolesProvider.overrideWithValue(roles),
      accountNotificationPreferencesProvider.overrideWith((ref) async => _matrix()),
      updateNotificationPreferenceProvider.overrideWithValue(update),
    ],
    child: accountScreenApp(const NotificationPreferencesScreen()),
  );
}

FilterChip _chip(WidgetTester tester, String key) =>
    tester.widget<FilterChip>(find.byKey(Key('notificationPref-$key')));

void main() {
  test('groups notification types into the settings categories', () {
    expect(
      notificationCategoryOf(
        NotificationPreferenceNotificationType.gradePosted,
      ),
      NotificationCategory.academic,
    );
    expect(
      notificationCategoryOf(
        NotificationPreferenceNotificationType.directMessage,
      ),
      NotificationCategory.communications,
    );
    expect(
      notificationCategoryOf(
        NotificationPreferenceNotificationType.attendanceAlert,
      ),
      NotificationCategory.family,
    );
    expect(
      notificationCategoryOf(
        NotificationPreferenceNotificationType.materialIngestFailed,
      ),
      NotificationCategory.teaching,
    );
  });

  testWidgets('saves a toggled channel and shows the server result', (
    tester,
  ) async {
    final updates = <NotificationPreferenceUpdate>[];
    await pumpAccountScreen(
      tester,
      _app(
        roles: const ['STUDENT'],
        update: (update) async {
          updates.add(update);
          return _matrix(gradePush: false);
        },
      ),
    );

    expect(find.text('Academic'), findsOneWidget);
    expect(find.text('Grade published'), findsOneWidget);
    expect(_chip(tester, 'GRADE_POSTED/push').selected, isTrue);

    await tester.tap(
      find.byKey(const Key('notificationPref-GRADE_POSTED/push')),
    );
    await tester.pumpAndSettle();

    expect(updates, hasLength(1));
    expect(
      updates.single.notificationType,
      NotificationPreferenceUpdateNotificationType.gradePosted,
    );
    expect(updates.single.channel, NotificationPreferenceUpdateChannel.push);
    expect(updates.single.enabled, isFalse);
    expect(_chip(tester, 'GRADE_POSTED/push').selected, isFalse);
  });

  testWidgets(
    'locks mandatory types and hides teaching types from non-teachers',
    (tester) async {
      await pumpAccountScreen(
        tester,
        _app(roles: const ['PARENT'], update: (_) async => _matrix()),
      );

      expect(
        find.text('Your school requires this notification.'),
        findsOneWidget,
      );
      expect(_chip(tester, 'ADMIN_ANNOUNCEMENT/in_app').onSelected, isNull);
      expect(find.text('Teaching materials'), findsNothing);
    },
  );

  testWidgets('shows teaching types to teachers', (tester) async {
    await pumpAccountScreen(
      tester,
      _app(roles: const ['INSTRUCTOR'], update: (_) async => _matrix()),
    );

    expect(find.text('Teaching materials'), findsOneWidget);
    expect(find.text('File ready for AI'), findsOneWidget);
  });
}
