import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/child_comparison_report.dart';
import 'package:studafy_mobile/src/core/api/generated/models/term.dart';
import 'package:studafy_mobile/src/features/parent/application/comparison_providers.dart';
import 'package:studafy_mobile/src/features/parent/presentation/comparison_screen.dart';
import 'package:studafy_mobile/src/features/parent/presentation/widgets/child_detail_placeholders.dart';
import 'package:studafy_mobile/src/features/student/application/grade_providers.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

Widget _app() {
  return Builder(
    builder: (context) => MaterialApp(
      debugShowCheckedModeBanner: false,
      locale: context.locale,
      supportedLocales: context.supportedLocales,
      localizationsDelegates: context.localizationDelegates,
      home: const ChildComparisonScreen(),
    ),
  );
}

Term _term(String id, {required int sequence, required String status}) {
  return Term.fromJson({
    'id': id,
    'school_id': 'school-1',
    'academic_year_id': 'year-1',
    'code': 'T$sequence',
    'name': 'Term $sequence',
    'sequence_number': sequence,
    'starts_on': '2026-01-01',
    'ends_on': '2026-04-01',
    'status': status,
    'created_at': '2026-01-01T00:00:00.000Z',
    'updated_at': '2026-01-01T00:00:00.000Z',
  });
}

Future<void> _pump(WidgetTester tester, ProviderScope scope) {
  return tester.pumpWidget(wrapWithLocalization(scope));
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('loading: shows the skeleton', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          comparisonReportProvider.overrideWith(
            (ref) => Completer<ChildComparisonReport>().future,
          ),
        ],
        child: _app(),
      ),
    );
    await tester.pump();

    expect(find.byType(ChildDetailSkeleton), findsOneWidget);
  });

  testWidgets('errored: shows the error message', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          comparisonReportProvider.overrideWith(
            (ref) => Future<ChildComparisonReport>.error(StateError('boom')),
          ),
        ],
        child: _app(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("Couldn't load the comparison."), findsOneWidget);
  });

  testWidgets('fewer than two linked children: states the requirement with the current count',
      (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          comparisonReportProvider.overrideWith(
            (ref) async => comparisonReport([childItem(id: 'child-1', name: 'Amir')]),
          ),
        ],
        child: _app(),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.text('Comparison needs at least two linked children (1 linked).'),
      findsOneWidget,
    );
    expect(find.byType(ChoiceChip), findsNothing);
  });

  testWidgets('no linked children at all: the same requirement message, at zero', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          comparisonReportProvider.overrideWith((ref) async => comparisonReport(const [])),
        ],
        child: _app(),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.text('Comparison needs at least two linked children (0 linked).'),
      findsOneWidget,
    );
  });

  testWidgets('two linked children: both names, attendance and completion bars render',
      (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          academicYearTermsProvider.overrideWith(
            (ref) async => [_term('term-1', sequence: 1, status: 'active')],
          ),
          comparisonReportProvider.overrideWith(
            (ref) async => comparisonReport([
              childItem(id: 'child-1', name: 'Amir'),
              childItem(id: 'child-2', name: 'Lina'),
            ]),
          ),
        ],
        child: _app(),
      ),
    );
    await tester.pumpAndSettle();

    // Each name appears once in the attendance card and once in the completion card — the grade
    // trend card's own legend stays hidden here since neither fixture's trend lines up with a
    // term the (single-term) academic year actually has.
    expect(find.text('Amir'), findsNWidgets(2));
    expect(find.text('Lina'), findsNWidgets(2));
    // Both fixtures default to 100% present and 90% complete.
    expect(find.text('100% present'), findsNWidgets(2));
    expect(find.text('90% complete'), findsNWidgets(2));
    expect(find.text('Not enough terms yet to plot a trend.'), findsOneWidget);
    // Only one term is in the year: the picker has nothing to pick, so it stays hidden.
    expect(find.byType(ChoiceChip), findsNothing);
  });

  testWidgets('grade trend: renders a legend entry per child once their trends share terms',
      (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          academicYearTermsProvider.overrideWith(
            (ref) async => [
              _term('term-0', sequence: 1, status: 'closed'),
              _term('term-1', sequence: 2, status: 'active'),
            ],
          ),
          comparisonReportProvider.overrideWith(
            (ref) async => comparisonReport([
              childItem(id: 'child-1', name: 'Amir', trendAverages: const [70, 78]),
              childItem(id: 'child-2', name: 'Lina', trendAverages: const [85, 90]),
            ]),
          ),
        ],
        child: _app(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Not enough terms yet to plot a trend.'), findsNothing);
    // Once per child: the grade-trend legend, the attendance row, the completion row.
    expect(find.text('Amir'), findsNWidgets(3));
    expect(find.text('Lina'), findsNWidgets(3));
  });

  testWidgets('two or more terms: the term picker renders one chip per term', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          academicYearTermsProvider.overrideWith(
            (ref) async => [
              _term('term-1', sequence: 1, status: 'closed'),
              _term('term-2', sequence: 2, status: 'active'),
            ],
          ),
          comparisonReportProvider.overrideWith(
            (ref) async => comparisonReport([
              childItem(id: 'child-1', name: 'Amir'),
              childItem(id: 'child-2', name: 'Lina'),
            ]),
          ),
        ],
        child: _app(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(ChoiceChip), findsNWidgets(2));
    expect(find.text('Term 1'), findsOneWidget);
    expect(find.text('Term 2'), findsOneWidget);
  });

  testWidgets('the share action is present but permanently disabled', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          academicYearTermsProvider.overrideWith((ref) async => const <Term>[]),
          comparisonReportProvider.overrideWith(
            (ref) async => comparisonReport([
              childItem(id: 'child-1', name: 'Amir'),
              childItem(id: 'child-2', name: 'Lina'),
            ]),
          ),
        ],
        child: _app(),
      ),
    );
    await tester.pumpAndSettle();

    final button = tester.widget<IconButton>(find.byType(IconButton));
    expect(button.onPressed, isNull);
    expect(button.tooltip, "Sharing is turned off to keep each child's data within your account.");
  });
}
