import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/term.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/features/student/application/current_term_provider.dart';
import 'package:studafy_mobile/src/features/teacher/application/teacher_providers.dart';
import 'package:studafy_mobile/src/features/teacher/domain/teacher_home.dart';

import '../support.dart';

Term _term() => Term.fromJson({
      'id': 'term-1',
      'school_id': 'school-1',
      'academic_year_id': 'year-1',
      'code': 'T1',
      'name': 'Term 1',
      'sequence_number': 1,
      'starts_on': '2026-01-01',
      'ends_on': '2026-04-01',
      'status': 'active',
      'created_at': '2026-01-01T00:00:00.000Z',
      'updated_at': '2026-01-01T00:00:00.000Z',
    });

ProviderContainer _container(FakeStudafyApiClient api) {
  final container = ProviderContainer(
    overrides: [
      apiClientProvider.overrideWithValue(api),
      currentTermProvider.overrideWith((ref) => _term()),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  group('teacherClassesProvider — own-classes scope', () {
    test('requests classes filtered by the signed-in teacher and drops any others', () async {
      final academics = FakeAcademicsClient(
        classes: [
          classFixture(id: 'mine', code: 'MATH101-A', leadTeacherId: 'teacher-1'),
          classFixture(id: 'other', code: 'PHYS101-A', leadTeacherId: 'teacher-2'),
        ],
      );
      final api = FakeStudafyApiClient(
        teachers: FakeTeachersClient(teacherProfile(id: 'teacher-1')),
        academics: academics,
      );

      final classes = await _container(api).read(teacherClassesProvider.future);

      expect(academics.lastLeadTeacherId, 'teacher-1');
      expect(classes.map((c) => c.id), ['mine']);
    });
  });

  group('teacherTodaySessionsProvider', () {
    test('keeps only today\'s slots for the signed-in teacher, ordered by period', () async {
      final today = DateTime.now().weekday;
      final tomorrow = today == 7 ? 1 : today + 1;

      final api = FakeStudafyApiClient(
        teachers: FakeTeachersClient(teacherProfile(id: 'teacher-1')),
        academics: FakeAcademicsClient(
          classes: [
            classFixture(id: 'c1', code: 'MATH101-A'),
            classFixture(id: 'c2', code: 'MATH102-A'),
          ],
        ),
        timetable: FakeTimetableClient(
          versions: [approvedVersion()],
          slots: [
            slotFixture(id: 's-late', classId: 'c1', teacherId: 'teacher-1', weekday: today, period: 4),
            slotFixture(id: 's-early', classId: 'c2', teacherId: 'teacher-1', weekday: today, period: 1),
            slotFixture(id: 's-other-teacher', classId: 'c1', teacherId: 'teacher-9', weekday: today, period: 2),
            slotFixture(id: 's-other-day', classId: 'c1', teacherId: 'teacher-1', weekday: tomorrow, period: 2),
          ],
        ),
        attendance: FakeAttendanceClient(
          sessionsByClassId: {
            'c2': [attendanceSession(classId: 'c2', status: 'submitted', period: 1)],
          },
        ),
      );

      final sessions = await _container(api).read(teacherTodaySessionsProvider.future);

      expect(sessions.map((s) => s.slot.id), ['s-early', 's-late']);
      expect(sessions.first.classCode, 'MATH102-A');
      expect(sessions.first.attendance, SessionAttendanceState.recorded);
      expect(sessions.last.attendance, SessionAttendanceState.notStarted);
    });

    test('is empty when the term has no approved timetable', () async {
      final api = FakeStudafyApiClient(
        timetable: FakeTimetableClient(versions: const []),
      );

      final sessions = await _container(api).read(teacherTodaySessionsProvider.future);

      expect(sessions, isEmpty);
    });
  });

  group('teacherPendingSubmissionsProvider', () {
    test('collects ungraded submitted work across published assignments, newest first', () async {
      final api = FakeStudafyApiClient(
        academics: FakeAcademicsClient(
          classes: [classFixture(id: 'c1', code: 'MATH101-A')],
        ),
        assignments: FakeAssignmentsClient(
          byClassId: {
            'c1': [
              assignmentFixture(id: 'a1', classId: 'c1', title: 'Essay'),
              assignmentFixture(id: 'a2', classId: 'c1', title: 'Draft', status: 'draft'),
            ],
          },
        ),
        submissions: FakeSubmissionsClient(
          byAssignmentId: {
            'a1': [
              submissionFixture(
                id: 'sub-old',
                assignmentId: 'a1',
                studentId: 'stu-1',
                submittedAt: DateTime.utc(2026, 3, 1),
              ),
              submissionFixture(
                id: 'sub-new',
                assignmentId: 'a1',
                studentId: 'stu-2',
                submittedAt: DateTime.utc(2026, 3, 5),
              ),
              submissionFixture(
                id: 'sub-withdrawn',
                assignmentId: 'a1',
                studentId: 'stu-3',
                submittedAt: DateTime.utc(2026, 3, 4),
                status: 'withdrawn',
              ),
            ],
            // a2 is a draft assignment — never queried, but guard anyway.
            'a2': [
              submissionFixture(
                id: 'sub-draft-assignment',
                assignmentId: 'a2',
                studentId: 'stu-4',
                submittedAt: DateTime.utc(2026, 3, 9),
              ),
            ],
          },
        ),
      );

      final pending = await _container(api).read(teacherPendingSubmissionsProvider.future);

      expect(pending.map((p) => p.submission.id), ['sub-new', 'sub-old']);
      expect(pending.first.assignment.title, 'Essay');
    });
  });

  group('classRosterProvider', () {
    test('returns the active roster oldest enrolment first', () async {
      final api = FakeStudafyApiClient(
        academics: FakeAcademicsClient(
          enrollmentsByClassId: {
            'c1': [
              enrollmentFixture(studentId: 'later', enrolledAt: '2026-02-01T00:00:00.000Z'),
              enrollmentFixture(studentId: 'earlier', enrolledAt: '2026-01-01T00:00:00.000Z'),
            ],
          },
        ),
      );

      final roster = await _container(api).read(classRosterProvider('c1').future);

      expect(roster.map((e) => e.studentId), ['earlier', 'later']);
    });
  });
}
