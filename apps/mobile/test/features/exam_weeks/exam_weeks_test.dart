import 'package:easy_localization/easy_localization.dart' hide TextDirection;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/exam_weeks/application/exam_weeks_providers.dart';
import 'package:studafy_mobile/src/features/exam_weeks/data/exam_weeks_client.dart';
import 'package:studafy_mobile/src/features/exam_weeks/domain/exam_weeks.dart';
import 'package:studafy_mobile/src/features/exam_weeks/presentation/exam_timetable_screen.dart';
import 'package:studafy_mobile/src/features/exam_weeks/presentation/invigilation_duties_screen.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';

import '../../support/ensure_date_formatting.dart';
import '../../support/wrap_with_localization.dart';

Map<String, Object?> _slot(
  String id,
  String subject,
  String date, {
  String startsAt = '09:00',
  String endsAt = '11:00',
  Map<String, Object?>? room,
  int? seat,
}) => {
  'id': id,
  'subject': {'id': 'sub-$id', 'code': subject.toUpperCase(), 'name': subject},
  'exam_date': date,
  'starts_at': startsAt,
  'ends_at': endsAt,
  'room': room,
  'seat_number': seat,
};

const _hall = {
  'id': 'room-hall',
  'code': 'HALL',
  'name': 'Main hall',
  'building': 'Block A',
  'floor': null,
};

final Map<String, Object?> _timetable = {
  'student_id': 'st-1',
  'timezone': 'Asia/Amman',
  'periods': [
    {
      'id': 'p-1',
      'name': 'Term 1 finals',
      'kind': 'final',
      'starts_on': '2026-12-07',
      'ends_on': '2026-12-14',
      'slots': [
        _slot(
          'phy',
          'Physics',
          '2026-12-09',
          startsAt: '10:00',
          endsAt: '12:00',
        ),
        _slot('math', 'Mathematics', '2026-12-08', room: _hall, seat: 12),
        _slot('old', 'Arabic', '2026-12-01', room: _hall, seat: 3),
      ],
    },
  ],
};

class _FakeClient implements ExamWeeksClient {
  _FakeClient({
    this.timetable = const {},
    this.duties = const {},
    this.fail = false,
  });

  final Object? timetable;
  final Object? duties;
  final bool fail;
  final requested = <String>[];

  @override
  Future<StudentExamTimetable> fetchStudentTimetable(String studentId) async {
    requested.add(studentId);
    if (fail) throw Exception('offline');
    return StudentExamTimetable.fromJson(timetable);
  }

  @override
  Future<InvigilationDuties> fetchMyDuties() async {
    if (fail) throw Exception('offline');
    return InvigilationDuties.fromJson(duties);
  }
}

Future<void> _pump(
  WidgetTester tester,
  _FakeClient client,
  Widget home, {
  Locale locale = AppLocales.fallback,
  String? currentStudentId = 'st-1',
}) async {
  tester.view.physicalSize = const Size(1080, 3000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          examWeeksClientProvider.overrideWithValue(client),
          currentStudentIdProvider.overrideWithValue(currentStudentId),
          examWeeksClockProvider.overrideWithValue(
            () => DateTime(2026, 12, 5, 8),
          ),
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

  group('parsing', () {
    test(
      'an unknown period kind, a malformed exam and missing fields never throw',
      () {
        final parsed = StudentExamTimetable.fromJson({
          'periods': [
            {
              'name': 'Mocks',
              'kind': 'quarterly',
              'slots': [
                _slot('ok', 'Math', '2027-01-10'),
                _slot('bad-date', 'Math', '2027-02-31'),
                _slot('bad-time', 'Math', '2027-01-11', startsAt: '9am'),
                {'id': 'empty'},
                'not a map',
              ],
            },
          ],
        });
        expect(parsed.timezone, isNull);
        expect(parsed.periods.single.kind, ExamPeriodKind.unknown);
        expect(parsed.periods.single.exams.map((e) => e.id), ['ok']);
        expect(parsed.periods.single.exams.single.room, isNull);
        expect(StudentExamTimetable.fromJson(null).isEmpty, isTrue);
        expect(StudentExamTimetable.fromJson('garbage').periods, isEmpty);
      },
    );

    test('exams are ordered by day then time; times keep the school clock', () {
      final period = StudentExamTimetable.fromJson(_timetable).periods.single;
      expect(period.exams.map((e) => e.id), ['old', 'math', 'phy']);
      expect(period.exams[1].startsAt, '09:00');
      expect(period.exams[1].date, DateTime(2026, 12, 8));
      expect(parseSchoolTime('09:30:00'), '09:30');
    });
  });

  testWidgets('a student sees their exams with room and seat, in school time', (
    tester,
  ) async {
    final client = _FakeClient(timetable: _timetable);
    await _pump(tester, client, const ExamTimetableScreen());

    expect(client.requested, ['st-1']);
    expect(find.text('Exam timetable'), findsOneWidget);
    expect(find.text('Times are school time (Asia/Amman).'), findsOneWidget);
    expect(find.text('Term 1 finals'), findsOneWidget);
    expect(
      find.textContaining('Main hall · Block A · seat 12'),
      findsOneWidget,
    );
    expect(find.textContaining('Room and seat not given yet'), findsOneWidget);
    expect(find.textContaining('09:00–11:00'), findsWidgets);
  });

  testWidgets('in Arabic the timetable reads right to left', (tester) async {
    await _pump(
      tester,
      _FakeClient(timetable: _timetable),
      const ExamTimetableScreen(),
      locale: const Locale('ar'),
    );
    expect(find.text('جدول الامتحانات'), findsOneWidget);
    expect(find.textContaining('المقعد 12'), findsOneWidget);
    final direction = Directionality.of(
      tester.element(find.text('Term 1 finals')),
    );
    expect(direction, TextDirection.rtl);
  });

  testWidgets('nothing published yet, or a failed load, says so', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeClient(timetable: {'periods': <Object?>[]}),
      const ExamTimetableScreen(),
    );
    expect(
      find.text('No exam timetable has been published yet.'),
      findsOneWidget,
    );

    await _pump(
      tester,
      _FakeClient(fail: true),
      const ExamTimetableScreen(studentId: 'st-2'),
    );
    expect(
      find.textContaining("Couldn't load the exam timetable"),
      findsOneWidget,
    );
  });

  testWidgets(
    "a parent's tile opens only their child's timetable, and hides when empty",
    (tester) async {
      final empty = _FakeClient(timetable: {'periods': <Object?>[]});
      await _pump(
        tester,
        empty,
        const Scaffold(body: ExamTimetableTile(studentId: 'child-1')),
        currentStudentId: null,
      );
      expect(find.text('Exam timetable'), findsNothing);

      final client = _FakeClient(timetable: _timetable);
      await _pump(
        tester,
        client,
        const Scaffold(
          body: ExamTimetableTile(studentId: 'child-1', studentName: 'Lina'),
        ),
        currentStudentId: null,
      );
      await tester.tap(find.text('Exam timetable'));
      await tester.pumpAndSettle();
      expect(find.text('Lina'), findsOneWidget);
      expect(client.requested.toSet(), {'child-1'});
      expect(find.textContaining('seat 12'), findsOneWidget);
    },
  );

  testWidgets('a teacher sees upcoming and past invigilation duties', (
    tester,
  ) async {
    final duty = {
      'slot_id': 's-1',
      'period': {'id': 'p-1', 'name': 'Term 1 finals'},
      'subject': {'id': 'sub', 'code': 'MATH', 'name': 'Mathematics'},
      'grade_level': {'id': 'g', 'name': 'Grade 10'},
      'sections': [
        {'id': 'a', 'name': 'A'},
        {'id': 'b', 'name': 'B'},
      ],
      'exam_date': '2026-12-08',
      'starts_at': '09:00',
      'ends_at': '11:00',
      'room': _hall,
    };
    final client = _FakeClient(
      duties: {
        'timezone': 'Asia/Amman',
        'duties': [
          duty,
          {...duty, 'slot_id': 's-0', 'exam_date': '2026-12-01'},
          {...duty, 'room': null},
        ],
      },
    );
    await _pump(tester, client, const InvigilationDutiesScreen());
    expect(find.text('Invigilation duties'), findsOneWidget);
    expect(find.text('Mathematics · Grade 10 · A, B'), findsNWidgets(2));
    expect(find.text('Past duties'), findsOneWidget);
    expect(find.textContaining('Room: Main hall · Block A'), findsNWidgets(2));
  });

  testWidgets('the teacher home card shows only while a duty is coming up', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeClient(duties: {'duties': <Object?>[]}),
      const Scaffold(body: InvigilationDutiesCard()),
    );
    expect(find.text('Invigilation duties'), findsNothing);

    await _pump(
      tester,
      _FakeClient(
        duties: {
          'duties': [
            {
              'period': {'name': 'Finals'},
              'subject': {'name': 'Physics'},
              'grade_level': {'name': 'Grade 11'},
              'sections': <Object?>[],
              'exam_date': '2026-12-09',
              'starts_at': '10:00',
              'ends_at': '12:00',
              'room': _hall,
            },
          ],
        },
      ),
      const Scaffold(body: InvigilationDutiesCard()),
    );
    expect(find.text('Invigilation duties'), findsOneWidget);
    expect(find.textContaining('Next: Physics'), findsOneWidget);
  });
}
