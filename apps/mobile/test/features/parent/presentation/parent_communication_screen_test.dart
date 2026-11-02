import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification.dart' as api_models;
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/features/parent/application/parent_providers.dart';
import 'package:studafy_mobile/src/features/parent/presentation/parent_communication_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

Widget _app({int initialTabIndex = 0}) {
  return Builder(
    builder: (context) => MaterialApp(
      debugShowCheckedModeBanner: false,
      locale: context.locale,
      supportedLocales: context.supportedLocales,
      localizationsDelegates: context.localizationDelegates,
      home: ParentCommunicationScreen(initialTabIndex: initialTabIndex),
    ),
  );
}

Future<void> _pump(WidgetTester tester, ProviderScope scope) {
  return tester.pumpWidget(wrapWithLocalization(scope));
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('the messages tab shows only announcements', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          parentCommunicationFeedProvider.overrideWith(
            (ref) async => <api_models.Notification>[
              notificationFixture(
                id: 'm1',
                title: 'Campus closed Friday',
                notificationType: 'ANNOUNCEMENT',
              ),
              notificationFixture(
                id: 'a1',
                title: 'Amir has been absent 3 days',
                notificationType: 'ATTENDANCE_ALERT',
              ),
              notificationFixture(
                id: 'g1',
                title: 'Grade posted',
                notificationType: 'GRADE_POSTED',
              ),
            ],
          ),
        ],
        child: _app(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Campus closed Friday'), findsOneWidget);
    expect(find.text('Amir has been absent 3 days'), findsNothing);
    expect(find.text('Grade posted'), findsNothing);
  });

  testWidgets('the alerts tab shows only attendance alerts and the current threshold',
      (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          parentCommunicationFeedProvider.overrideWith(
            (ref) async => <api_models.Notification>[
              notificationFixture(
                id: 'm1',
                title: 'Campus closed Friday',
                notificationType: 'ANNOUNCEMENT',
              ),
              notificationFixture(
                id: 'a1',
                title: 'Amir has been absent 3 days',
                notificationType: 'ATTENDANCE_ALERT',
              ),
            ],
          ),
          notificationPreferencesProvider.overrideWith(
            (ref) async => notificationPreferencesFixture(attendanceAlertThreshold: 4),
          ),
        ],
        child: _app(initialTabIndex: 1),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Amir has been absent 3 days'), findsOneWidget);
    expect(find.text('Campus closed Friday'), findsNothing);
    expect(find.text('Alerting after 4 absences.'), findsOneWidget);
  });

  testWidgets('editing the threshold round-trips through the preferences API', (tester) async {
    final apiClient = FakeStudafyApiClient(
      notifications: FakeNotificationsClient(
        notifications: const [],
        preferences: notificationPreferencesFixture(),
      ),
    );

    await _pump(
      tester,
      ProviderScope(
        overrides: [apiClientProvider.overrideWithValue(apiClient)],
        child: _app(initialTabIndex: 1),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("Using the school's default threshold."), findsOneWidget);

    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();

    expect(find.text('Use school default'), findsOneWidget);

    await tester.tap(find.byType(SwitchListTile));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextFormField), '5');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(apiClient.notifications.lastThresholdUpdate, 5);
    expect(find.text('Alerting after 5 absences.'), findsOneWidget);
  });
}
