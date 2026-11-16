import 'package:easy_localization/easy_localization.dart' hide TextDirection;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/released_marks_providers.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';
import 'package:studafy_mobile/src/features/parent/application/parent_providers.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';
import 'package:studafy_mobile/src/features/shell/domain/shell_role.dart';
import 'package:studafy_mobile/src/features/student/presentation/released_marks_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/fake_released_marks_client.dart';
import '../../../support/wrap_with_localization.dart';
import '../../parent/support.dart';

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

Future<void> _pump(
  WidgetTester tester,
  FakeReleasedMarksClient client, {
  Widget home = const ReleasedMarksScreen(),
  String? currentStudentId = 'st-1',
  Locale locale = AppLocales.fallback,
  ShellRole role = ShellRole.student,
  List<Object> extraOverrides = const [],
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
          shellRoleProvider.overrideWithValue(role),
          ...extraOverrides.cast(),
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
      final client = FakeReleasedMarksClient(
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
      expect(find.text('Exam marks'), findsOneWidget);
      // No release times from this payload: the first one in the API's order leads.
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('released-marks-latest')),
          matching: find.text('Midterm S1'),
        ),
        findsOneWidget,
      );
      expect(find.text('Semester 1'), findsOneWidget);
      expect(find.text('Semester 2'), findsOneWidget);
      expect(find.text('Full year'), findsOneWidget);
      // One year only: no year heading.
      expect(find.text('2025–2026'), findsNothing);

      expect(find.text('Science'), findsNWidgets(3));
      expect(find.text('Midterm'), findsNWidgets(2));
      expect(find.text('Final exam'), findsOneWidget);
      // In its row, and in the hero as the latest mark.
      expect(find.text('40 / 50'), findsNWidgets(2));
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
      final client = FakeReleasedMarksClient();
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
      expect(find.text('No exam marks yet'), findsOneWidget);
    },
  );

  testWidgets(
    'a single released exam shows its own mark and says the term is not final',
    (tester) async {
      final client = FakeReleasedMarksClient(
        periods: [
          _period('t1', 'Semester 1', [
            {
              ..._subject('Mathematics', [
                _category('Exams', 'exam', [
                  _assessment('First exam', 50, [_graded(44)]),
                ]),
              ]),
              // Only the first exam is out: the term's sheet is not approved.
              'approved_at': null,
              'period_approved': false,
            },
            _subject('Science', [
              _category('Midterm', 'midterm', [
                _assessment('Midterm S1', 50, [_graded(40)]),
              ]),
            ]),
          ]),
        ],
      );
      await _pump(tester, client);

      // In its row, and in the hero as the latest mark.
      expect(find.text('First exam'), findsNWidgets(2));
      expect(find.text('44 / 50'), findsNWidgets(2));
      expect(
        find.byKey(const ValueKey('released-marks-partial-sub-Mathematics')),
        findsOneWidget,
      );
      expect(find.text('More to come'), findsOneWidget);
      expect(
        find.text(
          'More marks for this term are still to come. The term result is not final yet.',
        ),
        findsOneWidget,
      );
      // Science's whole term is approved: its date, and no "still to come" note.
      expect(find.textContaining('Approved'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('released-marks-partial-sub-Science')),
        findsNothing,
      );
      // No total or percentage anywhere.
      expect(find.textContaining('%'), findsNothing);
    },
  );

  testWidgets('a failed load offers a retry', (tester) async {
    final client = FakeReleasedMarksClient(fail: true);
    await _pump(tester, client);

    expect(find.text("Couldn't load marks."), findsOneWidget);
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(client.requestedStudents, ['st-1', 'st-1']);
  });

  testWidgets('renders in Arabic', (tester) async {
    final client = FakeReleasedMarksClient(
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

    expect(find.text('درجات الاختبارات'), findsOneWidget);
    expect(find.text('العام الدراسي كاملًا'), findsOneWidget);
    // The mark reads "90 / 100" left to right, not "100 / 90", inside the RTL page.
    for (final mark in tester.elementList(find.text('90 / 100'))) {
      final text = mark.widget as Text;
      expect(text.textDirection ?? Directionality.of(mark), TextDirection.ltr);
    }
    expect(find.text('90 / 100'), findsNWidgets(2));
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    "the notification's case: one exam of a term out on its own, no term sheet yet",
    (tester) async {
      final client = FakeReleasedMarksClient(
        periods: singleReleasedExamPeriods(
          releasedAt: DateTime.utc(2026, 11, 16, 10),
        ),
      );
      // Exactly what the MARKS_RELEASED route builds: the student's id from the link.
      await _pump(
        tester,
        client,
        home: const ReleasedMarksScreen(studentId: 'st-1'),
      );

      expect(client.requestedStudents, ['st-1']);
      final hero = find.byKey(const ValueKey('released-marks-latest'));
      expect(
        find.descendant(of: hero, matching: find.text('First month')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: hero, matching: find.text('17.5 / 20')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: hero,
          matching: find.text('Mathematics · First term'),
        ),
        findsOneWidget,
      );
      expect(find.text('First term'), findsOneWidget);
      expect(find.text('Mathematics'), findsOneWidget);
      expect(find.text('Monthly exams'), findsOneWidget);
      expect(find.text('Released Nov 16, 2026'), findsOneWidget);
      expect(find.text('More to come'), findsOneWidget);
      expect(find.textContaining('Approved'), findsNothing);
      expect(find.text('No exam marks yet'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets("a parent's notification link shows which child it is about", (
    tester,
  ) async {
    final client = FakeReleasedMarksClient(
      periods: singleReleasedExamPeriods(
        releasedAt: DateTime.utc(2026, 11, 16),
      ),
    );
    await _pump(
      tester,
      client,
      // The route carries only the id; the parent has two children.
      home: const ReleasedMarksScreen(studentId: 'child-2'),
      currentStudentId: null,
      role: ShellRole.parent,
      extraOverrides: [
        linkedChildrenProvider.overrideWithValue(
          AsyncData([
            childItem(id: 'child-1', name: 'Omar Haddad'),
            childItem(id: 'child-2', name: 'Lina Haddad'),
          ]),
        ),
      ],
    );

    expect(client.requestedStudents, ['child-2']);
    expect(find.text('Lina Haddad'), findsOneWidget);
    expect(find.text('Omar Haddad'), findsNothing);
    expect(find.text('17.5 / 20'), findsNWidgets(2));
  });
}
