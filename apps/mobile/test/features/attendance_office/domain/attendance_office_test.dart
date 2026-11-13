import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/attendance_office/domain/attendance_office.dart';
import 'package:studafy_mobile/src/features/teacher/domain/attendance_taking.dart';

import '../support.dart';

void main() {
  group('RegisterState / RegisterCounts', () {
    test(
      'no session is not started; open/draft is in progress; submitted/locked is submitted',
      () {
        expect(RegisterState.of(null), RegisterState.notStarted);
        expect(
          RegisterState.of(dailySession(classId: 'c', status: 'draft')),
          RegisterState.inProgress,
        );
        expect(
          RegisterState.of(dailySession(classId: 'c', status: 'open')),
          RegisterState.inProgress,
        );
        expect(
          RegisterState.of(dailySession(classId: 'c', status: 'submitted')),
          RegisterState.submitted,
        );
        expect(
          RegisterState.of(dailySession(classId: 'c', status: 'locked')),
          RegisterState.submitted,
        );
      },
    );

    test('counts each state', () {
      final counts = RegisterCounts.of([
        ClassRegisterSummary(
          classInfo: officeClass(id: 'a', code: 'A'),
          session: null,
        ),
        ClassRegisterSummary(
          classInfo: officeClass(id: 'b', code: 'B'),
          session: null,
        ),
        ClassRegisterSummary(
          classInfo: officeClass(id: 'c', code: 'C'),
          session: dailySession(classId: 'c', status: 'open'),
        ),
        ClassRegisterSummary(
          classInfo: officeClass(id: 'd', code: 'D'),
          session: dailySession(classId: 'd', status: 'submitted'),
        ),
      ]);
      expect(
        (counts.notStarted, counts.inProgress, counts.submitted),
        (2, 1, 1),
      );
    });
  });

  group('pickCurrentTerm', () {
    final t1 = termFixture(
      id: 't1',
      startsOn: '2026-09-01',
      endsOn: '2026-12-20',
    );
    final t2 = termFixture(
      id: 't2',
      startsOn: '2027-01-05',
      endsOn: '2027-04-01',
    );

    test('the term containing today', () {
      expect(pickCurrentTerm([t2, t1], DateTime(2026, 10, 13))?.id, 't1');
      expect(pickCurrentTerm([t2, t1], DateTime(2026, 12, 20, 15))?.id, 't1');
    });

    test('else the next to start, else the last', () {
      expect(pickCurrentTerm([t1, t2], DateTime(2026, 12, 25))?.id, 't2');
      expect(pickCurrentTerm([t1, t2], DateTime(2027, 6, 1))?.id, 't2');
      expect(pickCurrentTerm(const [], DateTime(2027, 6, 1)), isNull);
    });
  });

  test('pickCurrentYear prefers the active year, else the latest', () {
    expect(
      pickCurrentYear([
        yearFixture(id: 'a', status: 'closed'),
        yearFixture(id: 'b'),
      ])?.id,
      'b',
    );
    expect(pickCurrentYear([yearFixture(id: 'a', status: 'closed')])?.id, 'a');
  });

  test(
    'ymd is date-only',
    () => expect(ymd(DateTime(2026, 3, 7, 23, 59)), '2026-03-07'),
  );

  group('OfficeMark', () {
    test('late needs whole minutes >= 1', () {
      const late = OfficeMark(status: AttendanceMarkStatus.late);
      expect(late.isValid, isFalse);
      expect(late.copyWith(minutesLateText: '0').isValid, isFalse);
      expect(late.copyWith(minutesLateText: '7').isValid, isTrue);
      expect(OfficeMark.present.isValid, isTrue);
    });

    test('batch item sends minutes_late only for late', () {
      expect(OfficeBatchItem.fromMark('s1', OfficeMark.present).toJson(), {
        'student_id': 's1',
        'status': 'present',
      });
      expect(
        OfficeBatchItem.fromMark(
          's2',
          const OfficeMark(
            status: AttendanceMarkStatus.late,
            minutesLateText: '12',
          ),
        ).toJson(),
        {'student_id': 's2', 'status': 'late', 'minutes_late': 12},
      );
    });
  });

  test('OfficeRegister.toMark skips students already recorded', () {
    final register = OfficeRegister(
      rosterStudentIds: const ['s1', 's2', 's3'],
      session: dailySession(classId: 'c', status: 'open'),
      records: [recordFixture(studentId: 's2', sessionId: 'session-c')],
    );
    expect(register.toMark, ['s1', 's3']);
    expect(register.isSubmitted, isFalse);
  });
}
