import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/enrollment.dart';
import 'package:studafy_mobile/src/features/custom_lists/application/custom_lists_providers.dart';
import 'package:studafy_mobile/src/features/custom_lists/data/custom_lists_client.dart';
import 'package:studafy_mobile/src/features/custom_lists/domain/custom_list.dart';
import 'package:studafy_mobile/src/features/custom_lists/presentation/student_custom_lists_screen.dart';
import 'package:studafy_mobile/src/features/messaging/application/messaging_providers.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';
import 'package:studafy_mobile/src/features/teacher/application/student_overview_providers.dart';
import 'package:studafy_mobile/src/features/teacher/application/teacher_providers.dart';
import 'package:studafy_mobile/src/features/teacher/domain/student_overview.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/teacher_class_detail_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/teacher_student_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/widgets/roster_entry_tile.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

/// Custom lists for the roster tests: nothing links anywhere, and every call is recorded.
class _NoLinkedRows implements CustomListsClient {
  final List<(String, String)> linkedCalls = [];

  @override
  Future<List<LinkedCustomList>> linked(String kind, String id) async {
    linkedCalls.add((kind, id));
    return const [];
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

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
      home: const TeacherClassDetailScreen(
        classId: 'class-1',
        classCode: 'MATH101-A',
      ),
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
          // No staff role: the Lists section and the roster tap stay out of the way.
          sessionRolesProvider.overrideWithValue(const <String>[]),
          classCourseNameProvider(
            'class-1',
          ).overrideWith((ref) => 'Mathematics'),
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
          // No staff role: the Lists section and the roster tap stay out of the way.
          sessionRolesProvider.overrideWithValue(const <String>[]),
          classCourseNameProvider(
            'class-1',
          ).overrideWith((ref) => 'Mathematics'),
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

  testWidgets('falls back to a short student id while no name resolver exists', (
    tester,
  ) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          // No staff role: the Lists section and the roster tap stay out of the way.
          sessionRolesProvider.overrideWithValue(const <String>[]),
          classCourseNameProvider(
            'class-1',
          ).overrideWith((ref) => 'Mathematics'),
          classRosterProvider('class-1').overrideWith(
            (ref) => [enrollmentFixture(studentId: 'student-abcdef')],
          ),
        ],
        child: _detailApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Student abcdef'), findsOneWidget);
  });

  testWidgets('shows the name when the resolver seam is populated', (
    tester,
  ) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          // No staff role: the Lists section and the roster tap stay out of the way.
          sessionRolesProvider.overrideWithValue(const <String>[]),
          classCourseNameProvider(
            'class-1',
          ).overrideWith((ref) => 'Mathematics'),
          classRosterProvider('class-1').overrideWith(
            (ref) => [enrollmentFixture(studentId: 'student-abcdef')],
          ),
          rosterStudentNameProvider(
            'student-abcdef',
          ).overrideWithValue('Sara Ahmed'),
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
          // No staff role: the Lists section and the roster tap stay out of the way.
          sessionRolesProvider.overrideWithValue(const <String>[]),
          classCourseNameProvider(
            'class-1',
          ).overrideWith((ref) => 'Mathematics'),
          classRosterProvider('class-1').overrideWith((ref) => <Enrollment>[]),
        ],
        child: _detailApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No students enrolled yet.'), findsOneWidget);
  });

  testWidgets(
    "a teacher opens the student's page from the roster, and the school lists from there",
    (tester) async {
      final lists = _NoLinkedRows();
      await _pump(
        tester,
        ProviderScope(
          overrides: [
            sessionRolesProvider.overrideWithValue(const ['INSTRUCTOR']),
            customListsClientProvider.overrideWithValue(lists),
            classCourseNameProvider(
              'class-1',
            ).overrideWith((ref) => 'Mathematics'),
            classRosterProvider('class-1').overrideWith(
              (ref) => [enrollmentFixture(studentId: 'student-abcdef')],
            ),
            rosterStudentNameProvider(
              'student-abcdef',
            ).overrideWithValue('Sara Ahmed'),
            studentOverviewProvider((
              classId: 'class-1',
              studentId: 'student-abcdef',
            )).overrideWith(
              (ref) => StudentOverview.fromJson(const {
                'class': {
                  'code': 'MATH101-A',
                  'subject_name': 'Math',
                  'term_name': 'Term 1',
                },
                'student': {
                  'id': 'student-abcdef',
                  'first_name': 'Sara',
                  'last_name': 'Ahmed',
                },
                'marks': null,
                'marks_unavailable': 'no_section',
                'attendance': {'sessions': 0},
                'homework': {'total': 0},
                'report_comments': <String, Object?>{},
                'records': <Object?>[],
              }),
            ),
            teacherMessagingContactsProvider.overrideWith((ref) => const []),
          ],
          child: _detailApp(),
        ),
      );
      await tester.pumpAndSettle();
      // The class's own Lists section asked, found nothing, and takes no space.
      expect(lists.linkedCalls, [('class', 'class-1')]);
      expect(find.byKey(const Key('linkedCustomLists')), findsNothing);

      await tester.tap(find.text('Sara Ahmed'));
      await tester.pumpAndSettle();
      expect(find.byType(TeacherStudentScreen), findsOneWidget);

      await tester.scrollUntilVisible(
        find.text("See this student in the school's lists"),
        200,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.tap(find.text("See this student in the school's lists"));
      await tester.pumpAndSettle();
      expect(find.byType(StudentCustomListsScreen), findsOneWidget);
      expect(lists.linkedCalls.last, ('student', 'student-abcdef'));
      expect(find.text('No lists mention this student.'), findsOneWidget);
    },
  );

  testWidgets('without a staff role the roster is not tappable', (
    tester,
  ) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          // No staff role: the Lists section and the roster tap stay out of the way.
          sessionRolesProvider.overrideWithValue(const <String>[]),
          classCourseNameProvider(
            'class-1',
          ).overrideWith((ref) => 'Mathematics'),
          classRosterProvider('class-1').overrideWith(
            (ref) => [enrollmentFixture(studentId: 'student-abcdef')],
          ),
        ],
        child: _detailApp(),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.ancestor(
        of: find.byType(RosterEntryTile),
        matching: find.byType(InkWell),
      ),
      findsNothing,
    );
    expect(
      find.descendant(
        of: find.byType(RosterEntryTile),
        matching: find.byType(InkWell),
      ),
      findsNothing,
    );
  });
}
