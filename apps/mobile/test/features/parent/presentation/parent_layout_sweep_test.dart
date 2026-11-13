import 'package:drift/native.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';
import 'package:studafy_mobile/src/core/offline/offline_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/parent/application/child_detail_providers.dart';
import 'package:studafy_mobile/src/features/parent/application/comparison_providers.dart';
import 'package:studafy_mobile/src/features/parent/application/parent_providers.dart';
import 'package:studafy_mobile/src/features/parent/domain/family_finance.dart';
import 'package:studafy_mobile/src/features/parent/presentation/child_detail_screen.dart';
import 'package:studafy_mobile/src/features/parent/presentation/comparison_screen.dart';
import 'package:studafy_mobile/src/features/parent/presentation/parent_communication_screen.dart';
import 'package:studafy_mobile/src/features/parent/presentation/parent_home_screen.dart';
import 'package:studafy_mobile/src/features/student/application/grade_providers.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

/// Layout sweep for the parent screens: every screen at a small, a regular and a large iPhone, in
/// English and Arabic (RTL), with three children whose names are long enough to wrap. Any
/// RenderFlex overflow (or other layout error) fails the test, so a parent never sees the yellow
/// and black stripes — or a clipped chip like the one reported on build 1485.

const _sizes = <String, Size>{
  'iPhone SE': Size(320, 568),
  'iPhone 15': Size(390, 844),
  'iPhone 15 Pro Max': Size(430, 932),
};

const _longNames = {
  'child-1': 'elaf mohammad omar abdulrahman',
  'child-2': 'yousef mohammad omar abdulrahman',
  'child-3': 'سارة محمد عمر عبد الرحمن الخطيب',
};

FamilyFinanceView _finance() => FamilyFinanceView(
  sections: [
    for (final id in _longNames.keys)
      financeSection(
        studentId: id,
        totals: [moneyTotal(minor: 125000, amount: '125.000')],
      ),
  ],
  householdTotals: [moneyTotal(minor: 375000, amount: '375.000')],
  dataAsOf: null,
);

ProviderScope _scope(Widget home, {int childCount = 3}) {
  final ids = _longNames.keys.take(childCount).toList();
  return ProviderScope(
    overrides: [
      offlineDatabaseProvider.overrideWithValue(OfflineDatabase(NativeDatabase.memory())),
      childComparisonProvider.overrideWith(
        (ref) => comparisonReport([
          for (final id in ids)
            childItem(
              id: id,
              name: _longNames[id]!,
              totalRecords: 40,
              absentCount: id == 'child-2' ? 8 : 0,
              absentPercent: id == 'child-2' ? 20 : 0,
            ),
        ]),
      ),
      childBreakdownProvider.overrideWith(
        (ref, studentId) async => childBreakdown(id: studentId, name: _longNames[studentId]!),
      ),
      familyFinanceProvider.overrideWith((ref) async => _finance()),
      childTimetableProvider.overrideWith(
        (ref, studentId) async => childTimetableFixture(studentId: studentId),
      ),
      comparisonReportProvider.overrideWith(
        (ref) async => comparisonReport([
          for (final id in ids)
            childItem(id: id, name: _longNames[id]!, trendAverages: const [70, 82]),
        ]),
      ),
      academicYearTermsProvider.overrideWith((ref) async => [termFixture()]),
      parentCommunicationFeedProvider.overrideWith(
        (ref) async => [
          notificationFixture(
            id: 'm1',
            title: 'The school will be closed on Thursday for the national holiday celebrations.',
            notificationType: 'ANNOUNCEMENT',
          ),
          notificationFixture(
            id: 'a1',
            title: '${_longNames['child-2']} has been absent three days in a row this week.',
            notificationType: 'ATTENDANCE_ALERT',
          ),
        ],
      ),
      notificationPreferencesProvider.overrideWith(
        (ref) async => notificationPreferencesFixture(attendanceAlertThreshold: 3),
      ),
      parentNotificationsProvider.overrideWith(
        (ref) async => [
          notificationFixture(
            id: 'n1',
            title: 'The report card for the first term is ready to view at the school.',
          ),
        ],
      ),
    ],
    child: Builder(
      builder: (context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        locale: context.locale,
        supportedLocales: context.supportedLocales,
        localizationsDelegates: context.localizationDelegates,
        home: Scaffold(body: home),
      ),
    ),
  );
}

Future<void> _pumpAt(WidgetTester tester, Size size, Locale locale, Widget scope) async {
  tester.view
    ..physicalSize = size
    ..devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(wrapWithLocalization(scope, startLocale: locale));
  await tester.pumpAndSettle();
}

void _expectNoLayoutErrors(WidgetTester tester, String where) {
  final error = tester.takeException();
  expect(error, isNull, reason: '$where: $error');
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  for (final locale in AppLocales.supported) {
    for (final entry in _sizes.entries) {
      final label = '${entry.key}, ${locale.languageCode}';

      testWidgets('parent home lays out without overflow ($label)', (tester) async {
        await _pumpAt(tester, entry.value, locale, _scope(const ParentHomeScreen()));
        _expectNoLayoutErrors(tester, 'home');

        // Picking the last child scrolls its chip into view; still no overflow.
        await tester.tap(find.text(_longNames['child-3']!).first);
        await tester.pumpAndSettle();
        _expectNoLayoutErrors(tester, 'home after picking the third child');
      });

      testWidgets('parent home with one child lays out without overflow ($label)', (tester) async {
        await _pumpAt(
          tester,
          entry.value,
          locale,
          _scope(const ParentHomeScreen(), childCount: 1),
        );
        _expectNoLayoutErrors(tester, 'home, one child');
      });

      testWidgets('comparison screen lays out without overflow ($label)', (tester) async {
        await _pumpAt(tester, entry.value, locale, _scope(const ChildComparisonScreen()));
        _expectNoLayoutErrors(tester, 'comparison');
      });

      testWidgets('announcements and alerts lay out without overflow ($label)', (tester) async {
        for (final tab in const [0, 1]) {
          await _pumpAt(
            tester,
            entry.value,
            locale,
            _scope(ParentCommunicationScreen(initialTabIndex: tab)),
          );
          _expectNoLayoutErrors(tester, 'communication tab $tab');
        }
      });

      testWidgets('child page tabs lay out without overflow ($label)', (tester) async {
        await _pumpAt(tester, entry.value, locale, _scope(const ChildDetailScreen()));
        _expectNoLayoutErrors(tester, 'child page');

        final tabs = find.byType(Tab);
        final count = tabs.evaluate().length;
        for (var i = 0; i < count; i++) {
          await tester.tap(tabs.at(i));
          await tester.pumpAndSettle();
          _expectNoLayoutErrors(tester, 'child page tab $i');
        }
      });
    }
  }

  testWidgets('a long child name is shortened, not cut off by the card', (tester) async {
    await _pumpAt(
      tester,
      _sizes['iPhone SE']!,
      AppLocales.fallback,
      _scope(const ParentHomeScreen()),
    );

    final name = tester.widget<Text>(find.text(_longNames['child-1']!).first);
    expect(name.overflow, TextOverflow.ellipsis);
    expect(name.maxLines, 1);
    expect('parent.switcher.compare'.tr(), 'Compare');
  });
}
