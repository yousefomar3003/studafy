import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/released_marks_providers.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';
import 'package:studafy_mobile/src/features/student/data/released_marks_client.dart';
import 'package:studafy_mobile/src/features/student/domain/released_marks.dart';
import 'package:studafy_mobile/src/features/student/presentation/released_marks_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

Map<String, Object?> _assessment(
  String name,
  num max,
  List<Map<String, Object?>> attempts,
) => {
  'assessment_id': 'a-$name',
  'name': name,
  'max_marks': max,
  'assessment_date': null,
  'attempts': attempts,
};

Map<String, Object?> _graded(num score, {int attempt = 1}) => {
  'attempt': attempt,
  'status': 'graded',
  'score': score,
};

Map<String, Object?> _category(
  String name,
  String kind,
  List<Map<String, Object?>> assessments,
) => {
  'category_id': 'c-$name',
  'name': name,
  'kind': kind,
  'assessments': assessments,
};

Map<String, Object?> _subject(
  String name,
  List<Map<String, Object?>> categories,
) => {
  'subject_id': 'sub-$name',
  'subject_code': name.substring(0, 3).toUpperCase(),
  'subject_name': name,
  'approved_at': '2026-01-20T09:00:00.000Z',
  'categories': categories,
};

Map<String, Object?> _period(
  String? termId,
  String? termName,
  List<Map<String, Object?>> subjects, {
  String yearId = 'year-1',
  String yearName = '2025–2026',
}) => {
  'academic_year_id': yearId,
  'academic_year_name': yearName,
  'term_id': termId,
  'term_name': termName,
  'subjects': subjects,
};

class _FakeMarksClient implements ReleasedMarksClient {
  _FakeMarksClient({this.periods = const [], this.fail = false});

  final List<Map<String, Object?>> periods;
  final bool fail;
  final List<String> requestedStudents = [];

  @override
  Future<List<ReleasedMarkPeriod>> fetchMarks(String studentId) async {
    requestedStudents.add(studentId);
    if (fail) throw Exception('offline');
    return [for (final row in periods) ReleasedMarkPeriod.fromJson(row)];
  }
}

Future<void> _pump(
  WidgetTester tester,
  _FakeMarksClient client, {
  Widget home = const ReleasedMarksScreen(),
  String? currentStudentId = 'st-1',
  Locale locale = AppLocales.fallback,
}) async {
  tester.view.physicalSize = const Size(1080, 4000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        // A failed load stays failed until the user retries.
        retry: (_, _) => null,
        overrides: [
          releasedMarksClientProvider.overrideWithValue(client),
          currentStudentIdProvider.overrideWithValue(currentStudentId),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            debugShowCheckedModeBanner: false,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            theme: AppTheme.light,
            home: home,
          ),
        ),
      ),
      startLocale: locale,
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets(
    'shows each semester on its own, then the full-year final, by subject and category',
    (tester) async {
      final client = _FakeMarksClient(
        periods: [
          _period('t1', 'Semester 1', [
            _subject('Science', [
              _category('Midterm', 'midterm', [
                _assessment('Midterm S1', 50, [_graded(40)]),
              ]),
              _category('Homework', 'homework', [
                _assessment('Homework S1', 10, [
                  {'attempt': 1, 'status': 'absent', 'score': null},
                ]),
              ]),
            ]),
          ]),
          _period('t2', 'Semester 2', [
            _subject('Science', [
              _category('Midterm', 'midterm', [
                _assessment('Midterm S2', 50, [
                  _graded(20),
                  _graded(35.5, attempt: 2),
                ]),
              ]),
            ]),
          ]),
          _period(null, null, [
            _subject('Science', [
              _category('Final exam', 'final_exam', [
                _assessment('Final', 100, [_graded(90)]),
              ]),
            ]),
          ]),
        ],
      );
      await _pump(tester, client);

      expect(client.requestedStudents, ['st-1']);
      expect(find.text('Term marks'), findsOneWidget);
      expect(find.text('Semester 1'), findsOneWidget);
      expect(find.text('Semester 2'), findsOneWidget);
      expect(find.text('Full year'), findsOneWidget);
      // One year only: no year heading.
      expect(find.text('2025–2026'), findsNothing);

      expect(find.text('Science'), findsNWidgets(3));
      expect(find.text('Midterm'), findsNWidgets(2));
      expect(find.text('Final exam'), findsOneWidget);
      expect(find.text('40 / 50'), findsOneWidget);
      expect(find.text('Absent'), findsOneWidget);
      expect(find.text('20 / 50'), findsOneWidget);
      expect(find.text('Midterm S2 (retake)'), findsOneWidget);
      expect(find.text('35.5 / 50'), findsOneWidget);
      expect(find.text('90 / 100'), findsOneWidget);
      expect(find.textContaining('Approved'), findsNWidgets(3));
    },
  );

  testWidgets(
    'a parent opens it for their child, with the name under the title',
    (tester) async {
      final client = _FakeMarksClient();
      await _pump(
        tester,
        client,
        home: const ReleasedMarksScreen(
          studentId: 'child-7',
          studentName: 'Lina Haddad',
        ),
        currentStudentId: null,
      );

      expect(client.requestedStudents, ['child-7']);
      expect(find.text('Lina Haddad'), findsOneWidget);
      expect(find.textContaining('No approved marks yet'), findsOneWidget);
    },
  );

  testWidgets('a failed load offers a retry', (tester) async {
    final client = _FakeMarksClient(fail: true);
    await _pump(tester, client);

    expect(find.text("Couldn't load marks."), findsOneWidget);
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(client.requestedStudents, ['st-1', 'st-1']);
  });

  testWidgets('renders in Arabic', (tester) async {
    final client = _FakeMarksClient(
      periods: [
        _period(null, null, [
          _subject('Science', [
            _category('Final exam', 'final_exam', [
              _assessment('Final', 100, [_graded(90)]),
            ]),
          ]),
        ]),
      ],
    );
    await _pump(tester, client, locale: const Locale('ar'));

    expect(find.text('درجات الفصول'), findsOneWidget);
    expect(find.text('العام الدراسي كاملًا'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
