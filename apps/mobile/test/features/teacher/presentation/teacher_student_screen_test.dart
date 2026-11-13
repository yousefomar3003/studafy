import 'package:drift/native.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';
import 'package:studafy_mobile/src/core/offline/offline_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/messaging/application/messaging_providers.dart';
import 'package:studafy_mobile/src/features/messaging/domain/messaging.dart';
import 'package:studafy_mobile/src/features/messaging/presentation/chat_screen.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';
import 'package:studafy_mobile/src/features/teacher/application/student_overview_providers.dart';
import 'package:studafy_mobile/src/features/teacher/domain/student_overview.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/teacher_student_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../../messaging/support.dart';

const _key = (classId: 'class-1', studentId: 'student-1');

Map<String, Object?> _overviewJson({
  Map<String, Object?>? marks,
  String? unavailable,
}) => {
  'class': {
    'code': 'MATH12',
    'subject_name': 'Mathematics',
    'section_name': '12 A',
    'term_name': 'Term 1',
  },
  'student': {
    'id': 'student-1',
    'first_name': 'Sara',
    'last_name': 'Ahmed',
    'admission_number': 'A-17',
    'enrolled_at': '2026-09-01T00:00:00.000Z',
  },
  'marks': marks,
  'marks_unavailable': unavailable,
  'attendance': {
    'sessions': 10,
    'present': 7,
    'absent': 2,
    'late': 1,
    'excused': 0,
    'remote': 0,
    'recent': [
      {'session_date': '2026-10-02', 'status': 'absent', 'minutes_late': null},
    ],
  },
  'homework': {
    'total': 3,
    'handed_in': 1,
    'missing': 1,
    'upcoming': 1,
    'items': [
      {
        'title': 'Algebra worksheet',
        'due_at': '2026-10-01T09:00:00.000Z',
        'max_score': 10,
        'status': 'graded',
        'score': 9,
      },
      {
        'title': 'Fractions',
        'due_at': '2026-10-05T09:00:00.000Z',
        'max_score': 10,
        'status': 'missing',
        'score': null,
      },
    ],
  },
  'report_comments': {
    'term_subject_comment': 'Strong on algebra.',
    'annual_subject_comment': null,
    'term_teacher_comment': null,
  },
  'records': [
    {
      'field_id': 'f1',
      'label_en': 'Allergies',
      'label_ar': 'الحساسية',
      'value_en': 'Peanuts',
      'value_ar': 'الفول السوداني',
    },
  ],
};

const _outOf20 = <String, Object?>{
  'grading_method': 'weighted',
  'result_format': 'out_of',
  'result_scale_max': 20,
  'exempt': false,
  'status': 'complete',
  'percentage': 85,
  'provisional_percentage': 85,
  'display_value': 17,
  'grade_label': 'B',
  'passed': true,
  'term_percentage': null,
  'assessments': [
    {'name': 'Final', 'max_marks': 100, 'status': 'graded', 'score': 85},
    {'name': 'Quiz 2', 'max_marks': 20, 'status': 'pending', 'score': null},
  ],
};

FakeMessagingClient _client() => FakeMessagingClient(
  teacherContacts: const [
    TeacherMessagingStudent(
      id: 'student-1',
      name: 'Sara Ahmed',
      classes: [
        ContactClass(id: 'class-1', code: 'MATH12', courseName: 'Mathematics'),
      ],
      parents: [
        TeacherMessagingParent(
          parentId: 'parent-1',
          name: 'Huda Ahmed',
          relationship: 'mother',
          conversationId: null,
        ),
      ],
    ),
    TeacherMessagingStudent(
      id: 'someone-else',
      name: 'Other',
      classes: [],
      parents: [
        TeacherMessagingParent(
          parentId: 'parent-9',
          name: 'Not This Parent',
          relationship: 'father',
          conversationId: null,
        ),
      ],
    ),
  ],
  messages: {'conv-new': []},
);

Future<void> _pump(
  WidgetTester tester, {
  required Map<String, Object?> overview,
  FakeMessagingClient? client,
  List<String> roles = const ['INSTRUCTOR'],
}) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          offlineDatabaseProvider.overrideWithValue(
            OfflineDatabase(NativeDatabase.memory()),
          ),
          sessionRolesProvider.overrideWithValue(roles),
          studentOverviewProvider(
            _key,
          ).overrideWith((ref) => StudentOverview.fromJson(overview)),
          messagingClientProvider.overrideWithValue(client ?? _client()),
          messagingUserIdProvider.overrideWithValue(teacherUserId),
          chatClockProvider.overrideWithValue(() => fixedNow),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: const TeacherStudentScreen(
              classId: 'class-1',
              studentId: 'student-1',
              studentName: 'Sara Ahmed',
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _scrollTo(WidgetTester tester, Finder finder) => tester
    .scrollUntilVisible(finder, 200, scrollable: find.byType(Scrollable).first);

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets(
    'shows the result in the grade format, attendance, homework and comments',
    (tester) async {
      await _pump(tester, overview: _overviewJson(marks: _outOf20));

      expect(find.text('Sara Ahmed'), findsWidgets);
      expect(find.text('Admission no. A-17'), findsOneWidget);
      expect(find.text('MATH12 · Mathematics · 12 A · Term 1'), findsOneWidget);
      expect(find.text('17 out of 20'), findsOneWidget);
      expect(find.text('B'), findsOneWidget);
      expect(find.text('Passing'), findsOneWidget);
      expect(find.text('85 / 100'), findsOneWidget);
      expect(find.text('Not marked'), findsOneWidget);

      await _scrollTo(tester, find.text('Out of 10 lessons'));
      expect(find.text('7'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);

      await _scrollTo(tester, find.text('Fractions'));
      expect(find.text('9 / 10'), findsOneWidget);
      expect(find.text('Missing'), findsWidgets);

      await _scrollTo(tester, find.text('Strong on algebra.'));
      expect(find.text('This subject, this term'), findsOneWidget);
    },
  );

  testWidgets('a GPA grade shows GPA', (tester) async {
    await _pump(
      tester,
      overview: _overviewJson(
        marks: {
          ..._outOf20,
          'result_format': 'gpa',
          'result_scale_max': 4,
          'display_value': 3.5,
        },
      ),
    );
    expect(find.text('GPA 3.5 of 4'), findsOneWidget);
  });

  testWidgets('a subject without a grading setup says why there are no marks', (
    tester,
  ) async {
    await _pump(tester, overview: _overviewJson(unavailable: 'not_configured'));
    expect(
      find.text("Grading isn't set up for this subject yet."),
      findsOneWidget,
    );
  });

  testWidgets("lists only this student's parents and opens a chat with one", (
    tester,
  ) async {
    final client = _client();
    await _pump(
      tester,
      overview: _overviewJson(marks: _outOf20),
      client: client,
    );

    await _scrollTo(tester, find.text('Huda Ahmed'));
    expect(find.text('Mother'), findsOneWidget);
    expect(find.text('Not This Parent'), findsNothing);

    await tester.tap(find.byTooltip('Message'));
    await tester.pumpAndSettle();
    expect(client.startedByTeacher.single, (
      studentId: 'student-1',
      parentId: 'parent-1',
    ));
    final chat = tester.widget<ChatScreen>(find.byType(ChatScreen));
    expect(chat.viewer, MessagingViewer.teacher);
  });

  testWidgets('shows teacher-visible school information', (tester) async {
    await _pump(tester, overview: _overviewJson(marks: _outOf20));
    await _scrollTo(tester, find.text('Peanuts'));
    expect(find.text('School information'), findsOneWidget);
    expect(find.text('Allergies'), findsOneWidget);
  });
}
