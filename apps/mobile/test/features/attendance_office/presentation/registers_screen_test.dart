import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/attendance_office/application/attendance_office_providers.dart';
import 'package:studafy_mobile/src/features/attendance_office/presentation/register_screen.dart';
import 'package:studafy_mobile/src/features/attendance_office/presentation/registers_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

Future<void> _pump(WidgetTester tester, FakeAttendanceOfficeClient client) {
  return tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        retry: (_, _) => null,
        overrides: [
          attendanceOfficeClientProvider.overrideWithValue(client),
          authStatusProvider.overrideWithValue(AuthStatus.authenticated),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            debugShowCheckedModeBanner: false,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: const Scaffold(body: RegistersScreen()),
          ),
        ),
      ),
    ),
  );
}

FakeAttendanceOfficeClient _school() => FakeAttendanceOfficeClient(
  terms: [termFixture(startsOn: '2000-01-01', endsOn: '2100-01-01')],
  classes: [
    officeClass(id: 'c1', code: '7A'),
    officeClass(id: 'c2', code: '7B'),
    officeClass(id: 'c3', code: '8A'),
    officeClass(id: 'c4', code: '8B'),
    officeClass(id: 'c5', code: '9X', status: 'cancelled'),
  ],
  sessions: {
    'c2': dailySession(classId: 'c2', status: 'open'),
    'c3': dailySession(classId: 'c3', status: 'submitted'),
    'c4': dailySession(classId: 'c4', status: 'locked'),
  },
);

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets(
    'lists every non-cancelled class with its register state and counts',
    (tester) async {
      await _pump(tester, _school());
      await tester.pumpAndSettle();

      expect(find.text('7A'), findsOneWidget);
      expect(find.text('9X'), findsNothing);
      expect(find.text('1 not started'), findsOneWidget);
      expect(find.text('1 in progress'), findsOneWidget);
      expect(find.text('2 submitted'), findsOneWidget);
      expect(find.text('Not started'), findsOneWidget);
      expect(find.text('In progress'), findsOneWidget);
      expect(find.text('Submitted'), findsNWidgets(2));
      expect(find.bySemanticsLabel('7B, register In progress'), findsOneWidget);
    },
  );

  testWidgets('search filters by class code', (tester) async {
    await _pump(tester, _school());
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), '8');
    await tester.pumpAndSettle();

    expect(find.text('7A'), findsNothing);
    expect(find.text('8A'), findsOneWidget);
    expect(find.text('8B'), findsOneWidget);
  });

  testWidgets('a count chip filters to that state', (tester) async {
    await _pump(tester, _school());
    await tester.pumpAndSettle();

    await tester.tap(find.text('1 in progress'));
    await tester.pumpAndSettle();

    expect(find.text('7B'), findsOneWidget);
    expect(find.text('7A'), findsNothing);
    expect(find.text('8A'), findsNothing);
  });

  testWidgets('a load failure shows an error with retry', (tester) async {
    final client = _school()..throwOnRead = StateError('offline');
    await _pump(tester, client);
    await tester.pumpAndSettle();

    expect(find.text("Couldn't load the registers."), findsOneWidget);

    client.throwOnRead = null;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('7A'), findsOneWidget);
  });

  testWidgets('tapping a class opens its register', (tester) async {
    await _pump(tester, _school());
    await tester.pumpAndSettle();

    await tester.tap(find.text('7A'));
    await tester.pumpAndSettle();

    expect(find.byType(RegisterScreen), findsOneWidget);
  });
}
