import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/enrollment.dart';
import 'package:studafy_mobile/src/features/teacher/application/teacher_providers.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/teacher_class_detail_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/widgets/roster_entry_tile.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

Future<void> _pump(WidgetTester tester, ProviderScope scope) {
  return tester.pumpWidget(wrapWithLocalization(scope));
}

Widget _detailApp() {
  return Builder(
    builder: (context) => MaterialApp(
      debugShowCheckedModeBanner: false,
      locale: context.locale,
      supportedLocales: context.supportedLocales,
      localizationsDelegates: context.localizationDelegates,
      home: const TeacherClassDetailScreen(classId: 'class-1', classCode: 'MATH101-A'),
    ),
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('shows the class code and course name', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          classCourseNameProvider('class-1').overrideWith((ref) => 'Mathematics'),
          classRosterProvider('class-1').overrideWith((ref) => <Enrollment>[]),
        ],
        child: _detailApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('MATH101-A'), findsOneWidget); // app bar title
    expect(find.text('Mathematics'), findsOneWidget);
  });

  testWidgets('renders one row per active enrolment', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          classCourseNameProvider('class-1').overrideWith((ref) => 'Mathematics'),
          classRosterProvider('class-1').overrideWith(
            (ref) => [
              enrollmentFixture(studentId: 'student-aaaaaa'),
              enrollmentFixture(studentId: 'student-bbbbbb'),
            ],
          ),
        ],
        child: _detailApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(RosterEntryTile), findsNWidgets(2));
  });

  testWidgets('falls back to a short student id while no name resolver exists', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          classCourseNameProvider('class-1').overrideWith((ref) => 'Mathematics'),
          classRosterProvider('class-1')
              .overrideWith((ref) => [enrollmentFixture(studentId: 'student-abcdef')]),
        ],
        child: _detailApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Student abcdef'), findsOneWidget);
  });

  testWidgets('shows the name when the resolver seam is populated', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          classCourseNameProvider('class-1').overrideWith((ref) => 'Mathematics'),
          classRosterProvider('class-1')
              .overrideWith((ref) => [enrollmentFixture(studentId: 'student-abcdef')]),
          rosterStudentNameProvider('student-abcdef').overrideWithValue('Sara Ahmed'),
        ],
        child: _detailApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Sara Ahmed'), findsOneWidget);
    expect(find.text('Student abcdef'), findsNothing);
  });

  testWidgets('empty roster reads plainly', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          classCourseNameProvider('class-1').overrideWith((ref) => 'Mathematics'),
          classRosterProvider('class-1').overrideWith((ref) => <Enrollment>[]),
        ],
        child: _detailApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No students enrolled yet.'), findsOneWidget);
  });
}
