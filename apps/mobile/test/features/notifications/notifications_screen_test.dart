import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/notifications/presentation/notifications_screen.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';
import 'package:studafy_mobile/src/features/shell/domain/shell_role.dart';
import 'package:studafy_mobile/src/features/student/application/work_and_grades_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/work_and_grades.dart';

import '../../support/wrap_with_localization.dart';
import '../parent/support.dart';

Future<FakeNotificationsClient> _pump(
  WidgetTester tester, {
  required FakeNotificationsClient notifications,
  Locale locale = const Locale('en'),
  ShellRole role = ShellRole.attendanceOfficer,
}) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(
            FakeStudafyApiClient(notifications: notifications),
          ),
          shellRoleProvider.overrideWithValue(role),
        ],
        child: Builder(
          builder: (context) => MaterialApp.router(
            theme: AppTheme.light,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            // A tab target asks the router whether it can pop back to the shell.
            routerConfig: GoRouter(
              routes: [
                GoRoute(
                  path: '/',
                  builder: (context, state) => const NotificationsScreen(),
                ),
              ],
            ),
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

  testWidgets(
    "a student's grade notices open Work & grades on that kind of grade",
    (tester) async {
      await _pump(
        tester,
        role: ShellRole.student,
        notifications: FakeNotificationsClient(
          notifications: [
            notificationFixture(id: 'n-1', notificationType: 'MARKS_RELEASED'),
            notificationFixture(id: 'n-2', notificationType: 'GRADE_POSTED'),
          ],
        ),
      );
      final container = ProviderScope.containerOf(
        tester.element(find.byType(NotificationsScreen)),
      );

      await tester.tap(find.byKey(const Key('notification-n-1')));
      await tester.pumpAndSettle();
      expect(container.read(selectedShellTabProvider), workAndGradesTabKey);
      expect(
        container.read(workAndGradesProvider),
        const WorkAndGradesSelection(
          section: WorkAndGradesSection.grades,
          gradesTab: GradesTab.exams,
        ),
      );

      await tester.tap(find.byKey(const Key('notification-n-2')));
      await tester.pumpAndSettle();
      expect(
        container.read(workAndGradesProvider),
        const WorkAndGradesSelection(
          section: WorkAndGradesSection.grades,
          gradesTab: GradesTab.assignments,
        ),
      );
    },
  );

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
