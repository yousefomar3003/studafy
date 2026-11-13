import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/notifications/presentation/notifications_screen.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';
import 'package:studafy_mobile/src/features/shell/domain/shell_role.dart';

import '../../support/wrap_with_localization.dart';
import '../parent/support.dart';

Future<FakeNotificationsClient> _pump(
  WidgetTester tester, {
  required FakeNotificationsClient notifications,
  Locale locale = const Locale('en'),
}) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(
            FakeStudafyApiClient(notifications: notifications),
          ),
          shellRoleProvider.overrideWithValue(ShellRole.attendanceOfficer),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            theme: AppTheme.light,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: const NotificationsScreen(),
          ),
        ),
      ),
      startLocale: locale,
    ),
  );
  await tester.pumpAndSettle();
  return notifications;
}

void main() {
  testWidgets(
    'lists every notification, newest first, with the unread ones marked',
    (tester) async {
      await _pump(
        tester,
        notifications: FakeNotificationsClient(
          notifications: [
            notificationFixture(
              id: 'n-1',
              notificationType: 'ANNOUNCEMENT',
              title: 'School closed Sunday',
              body: 'Heavy rain is expected.',
            ),
            notificationFixture(
              id: 'n-2',
              notificationType: 'DIRECT_MESSAGE',
              title: 'New message from Ms Noor',
              body: 'See you tomorrow',
              readAt: DateTime.parse('2026-11-13T10:00:00Z'),
            ),
          ],
        ),
      );

      expect(find.text('Notifications'), findsOneWidget);
      expect(find.text('School closed Sunday'), findsOneWidget);
      expect(find.text('New message from Ms Noor'), findsOneWidget);
      expect(find.byKey(const Key('notificationsMarkAllRead')), findsOneWidget);
    },
  );

  testWidgets('tapping a notice marks it read and shows its full text', (
    tester,
  ) async {
    final client = await _pump(
      tester,
      notifications: FakeNotificationsClient(
        notifications: [
          notificationFixture(
            id: 'n-1',
            notificationType: 'ANNOUNCEMENT',
            title: 'School closed Sunday',
            body: 'Heavy rain is expected. Stay safe.',
          ),
        ],
      ),
    );

    await tester.tap(find.byKey(const Key('notification-n-1')));
    await tester.pumpAndSettle();

    expect(client.markedRead, ['n-1']);
    expect(find.text('Heavy rain is expected. Stay safe.'), findsWidgets);
    // Nothing unread left, so the action is gone.
    expect(find.byKey(const Key('notificationsMarkAllRead')), findsNothing);
  });

  testWidgets('an empty inbox says so', (tester) async {
    await _pump(tester, notifications: FakeNotificationsClient());
    expect(find.textContaining("You're all caught up"), findsOneWidget);
  });

  testWidgets('reads in Arabic', (tester) async {
    await _pump(
      tester,
      notifications: FakeNotificationsClient(),
      locale: const Locale('ar'),
    );
    expect(find.text('notifications.title'.tr()), findsOneWidget);
    expect(find.text('الإشعارات'), findsOneWidget);
  });
}
