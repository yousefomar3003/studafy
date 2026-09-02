import 'dart:async';

import 'package:drift/native.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/child_comparison_report.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification.dart' as api_models;
import 'package:studafy_mobile/src/core/offline/offline_database.dart';
import 'package:studafy_mobile/src/core/offline/offline_providers.dart';
import 'package:studafy_mobile/src/features/parent/application/comparison_providers.dart';
import 'package:studafy_mobile/src/features/parent/application/parent_providers.dart';
import 'package:studafy_mobile/src/features/parent/domain/child_fees.dart';
import 'package:studafy_mobile/src/features/parent/presentation/comparison_screen.dart';
import 'package:studafy_mobile/src/features/parent/presentation/parent_home_screen.dart';
import 'package:studafy_mobile/src/features/parent/presentation/widgets/child_attendance_card.dart';
import 'package:studafy_mobile/src/features/parent/presentation/widgets/parent_section_card.dart';
import 'package:studafy_mobile/src/features/student/application/grade_providers.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

Widget _homeApp() {
  return Builder(
    builder: (context) => MaterialApp(
      debugShowCheckedModeBanner: false,
      locale: context.locale,
      supportedLocales: context.supportedLocales,
      localizationsDelegates: context.localizationDelegates,
      home: const Scaffold(body: ParentHomeScreen()),
    ),
  );
}

Future<void> _pump(WidgetTester tester, ProviderScope scope) {
  return tester.pumpWidget(wrapWithLocalization(scope));
}

FamilyFinanceView _financeOwing() => FamilyFinanceView(
      outstandingByStudentId: {
        'child-1': [moneyTotal(minor: 125000, amount: '125.000')],
      },
      householdTotals: [moneyTotal(minor: 125000, amount: '125.000')],
      dataAsOf: null,
    );

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('shows skeletons while the children and feed load', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          childComparisonProvider
              .overrideWith((ref) => Completer<ChildComparisonReport>().future),
          familyFinanceProvider.overrideWith((ref) => Completer<FamilyFinanceView?>().future),
          parentNotificationsProvider
              .overrideWith((ref) => Completer<List<api_models.Notification>>().future),
        ],
        child: _homeApp(),
      ),
    );
    await tester.pump();

    expect(find.byType(ParentCardSkeleton), findsWidgets);
  });

  testWidgets('no linked children: the switcher says so and no summary card renders',
      (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          childComparisonProvider.overrideWith((ref) => comparisonReport(const [])),
          familyFinanceProvider.overrideWith((ref) async => null),
          parentNotificationsProvider.overrideWith((ref) async => <api_models.Notification>[]),
        ],
        child: _homeApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No children are linked to your account yet.'), findsOneWidget);
    expect(find.text("You're all caught up."), findsOneWidget);
    expect(find.byType(ChildAttendanceCard), findsNothing);
  });

  testWidgets('renders the selected child summary, fees due and the notifications feed',
      (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          childComparisonProvider.overrideWith(
            (ref) => comparisonReport([
              childItem(
                id: 'child-1',
                name: 'Amir',
                totalRecords: 40,
                absentCount: 6,
                absentPercent: 15,
                termAverage: 78,
                gpa: 2.9,
              ),
              childItem(id: 'child-2', name: 'Lina'),
            ]),
          ),
          familyFinanceProvider.overrideWith((ref) async => _financeOwing()),
          parentNotificationsProvider.overrideWith(
            (ref) async => [notificationFixture(id: 'n1', title: 'Report card ready')],
          ),
        ],
        child: _homeApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Amir'), findsOneWidget);
    expect(find.text('Lina'), findsOneWidget);
    expect(find.text('85% present · 6 absences this term'), findsOneWidget);
    expect(find.text('Needs attention'), findsOneWidget);
    expect(find.text('125.000 JOD outstanding'), findsOneWidget);
    expect(find.text('Report card ready'), findsOneWidget);
  });

  testWidgets('picking a child in the switcher swaps the summary', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          offlineDatabaseProvider.overrideWithValue(OfflineDatabase(NativeDatabase.memory())),
          childComparisonProvider.overrideWith(
            (ref) => comparisonReport([
              childItem(id: 'child-1', name: 'Amir', absentCount: 0),
              childItem(
                id: 'child-2',
                name: 'Lina',
                totalRecords: 20,
                absentCount: 3,
                absentPercent: 15,
              ),
            ]),
          ),
          familyFinanceProvider.overrideWith((ref) async => null),
          parentNotificationsProvider.overrideWith((ref) async => <api_models.Notification>[]),
        ],
        child: _homeApp(),
      ),
    );
    await tester.pumpAndSettle();

    // Defaults to the first child.
    expect(find.text('100% present · 0 absences this term'), findsOneWidget);

    await tester.tap(find.text('Lina'));
    await tester.pumpAndSettle();

    expect(find.text('85% present · 3 absences this term'), findsOneWidget);
  });

  testWidgets('one linked child: no compare entry point in the switcher', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          childComparisonProvider
              .overrideWith((ref) => comparisonReport([childItem(id: 'child-1', name: 'Amir')])),
          familyFinanceProvider.overrideWith((ref) async => null),
          parentNotificationsProvider.overrideWith((ref) async => <api_models.Notification>[]),
        ],
        child: _homeApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byIcon(Icons.compare_arrows), findsNothing);
  });

  testWidgets('two or more linked children: the switcher\'s compare action opens the comparison',
      (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          childComparisonProvider.overrideWith(
            (ref) => comparisonReport([
              childItem(id: 'child-1', name: 'Amir'),
              childItem(id: 'child-2', name: 'Lina'),
            ]),
          ),
          // The pushed screen reads its own term-scoped report and term list, not
          // `childComparisonProvider` — stub both so opening it never falls through to a real
          // network call.
          comparisonReportProvider.overrideWith(
            (ref) => comparisonReport([
              childItem(id: 'child-1', name: 'Amir'),
              childItem(id: 'child-2', name: 'Lina'),
            ]),
          ),
          academicYearTermsProvider.overrideWith((ref) async => const []),
          familyFinanceProvider.overrideWith((ref) async => null),
          parentNotificationsProvider.overrideWith((ref) async => <api_models.Notification>[]),
        ],
        child: _homeApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byIcon(Icons.compare_arrows), findsOneWidget);

    await tester.tap(find.byIcon(Icons.compare_arrows));
    await tester.pumpAndSettle();

    expect(find.byType(ChildComparisonScreen), findsOneWidget);
    expect(find.text('Amir'), findsWidgets);
  });
}
