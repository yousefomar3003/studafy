import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/intl.dart' as intl;
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/parent/application/parent_providers.dart';
import 'package:studafy_mobile/src/features/parent/domain/family_finance.dart';
import 'package:studafy_mobile/src/features/parent/presentation/widgets/child_finance_view.dart';
import 'package:studafy_mobile/src/features/parent/presentation/widgets/finance_student_ai_tile.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

/// The Student AI line in a child's Finance tab: "Student AI — included in your school fees", in
/// English and Arabic, with the start month for a late opt-in and the month it stopped for a
/// released seat — and never an amount (the school tells parents the price), nor anything about
/// what the school pays.
FamilyStudentAiLine _line({
  String startMonth = '2026-09',
  bool lateStart = false,
  String? stoppedFrom,
}) =>
    FamilyStudentAiLine.fromJson({
      'academic_year_id': '7a1e4a39-87c1-4a76-9a4c-0d36a6a3a2c1',
      'academic_year_name': '2026/27',
      'start_month': startMonth,
      'end_month': '2027-06',
      'late_start': lateStart,
      'stopped_from': stoppedFrom,
      'status': stoppedFrom == null ? 'active' : 'released',
    });

Future<void> _pump(WidgetTester tester, Widget child, {Locale locale = const Locale('en')}) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      Builder(
        builder: (context) => MaterialApp(
          theme: AppTheme.light,
          locale: context.locale,
          supportedLocales: context.supportedLocales,
          localizationsDelegates: context.localizationDelegates,
          home: Scaffold(body: child),
        ),
      ),
      startLocale: locale,
    ),
  );
  await tester.pumpAndSettle();
}

String _month(String locale, int year, int month) =>
    intl.DateFormat.yMMMM(locale).format(DateTime(year, month));

void main() {
  setUpAll(ensureDateFormattingInitialized);

  /// No money on screen: no currency, no decimal amount, no "×" multiplication.
  void expectNoAmount() =>
      expect(find.textContaining(RegExp(r'[$€£]|\d+[.,]\d{2}|×|USD|JOD')), findsNothing);

  testWidgets('the full-year line: included in the school fees, no amount', (tester) async {
    await _pump(tester, FinanceStudentAiTile(line: _line()));

    expect(find.text('Student AI — included in your school fees'), findsOneWidget);
    expect(find.text('2026/27'), findsOneWidget);
    expectNoAmount();
  });

  testWidgets('a late opt-in shows the month it starts', (tester) async {
    await _pump(
      tester,
      FinanceStudentAiTile(line: _line(startMonth: '2027-02', lateStart: true)),
    );

    expect(find.text('Student AI — included in your school fees'), findsOneWidget);
    expect(find.text('2026/27 · From ${_month('en', 2027, 2)}'), findsOneWidget);
    expectNoAmount();
  });

  testWidgets('a released seat shows the month it stopped from', (tester) async {
    await _pump(tester, FinanceStudentAiTile(line: _line(stoppedFrom: '2027-01')));

    expect(find.text('2026/27 · Stopped from ${_month('en', 2027, 1)}'), findsOneWidget);
    expectNoAmount();
  });

  testWidgets('Arabic: the line, a late start and a stop month', (tester) async {
    await _pump(
      tester,
      FinanceStudentAiTile(
        line: _line(startMonth: '2027-02', lateStart: true, stoppedFrom: '2027-07'),
      ),
      locale: const Locale('ar'),
    );

    expect(find.text('Student AI — ضمن الرسوم المدرسية'), findsOneWidget);
    expect(
      find.text(
        '2026/27 · ابتداءً من ${_month('ar', 2027, 2)} · توقف ابتداءً من ${_month('ar', 2027, 7)}',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('parent.childDetail'), findsNothing);
    expectNoAmount();
  });

  testWidgets('the Finance tab shows the Student AI card only for an opted-in child',
      (tester) async {
    FamilyFinanceView view(List<FamilyStudentAiLine> lines) => FamilyFinanceView(
          sections: [
            FamilyStudentFinance(
              studentId: 'child-1',
              invoices: const [],
              installments: const [],
              receipts: const [],
              totals: const [],
              studentAiLines: lines,
            ),
          ],
          householdTotals: const [],
          dataAsOf: null,
        );

    Future<void> pumpView(FamilyFinanceView finance) => _pump(
          tester,
          ProviderScope(
            // A fresh scope per pump, so the second view is read anew.
            key: UniqueKey(),
            overrides: [familyFinanceProvider.overrideWith((ref) async => finance)],
            child: const ChildFinanceView(studentId: 'child-1'),
          ),
        );

    await pumpView(view([_line()]));
    expect(find.text('Student AI'), findsOneWidget);
    expect(find.byType(FinanceStudentAiTile), findsOneWidget);
    // Nothing about the school's licence cost or a revenue share.
    expect(find.textContaining('licen'), findsNothing);
    expect(find.textContaining('share'), findsNothing);

    await pumpView(view(const []));
    expect(find.byType(FinanceStudentAiTile), findsNothing);
    expect(find.text('Student AI'), findsNothing);
  });
}
