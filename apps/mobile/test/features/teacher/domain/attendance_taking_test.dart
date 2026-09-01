import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_record.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_record_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_session.dart';
import 'package:studafy_mobile/src/core/api/generated/models/batch_record_item_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/enrollment.dart';
import 'package:studafy_mobile/src/features/teacher/domain/attendance_taking.dart';

const _t0 = '2026-01-01T00:00:00.000Z';

Enrollment _enrolment(String studentId) => Enrollment.fromJson({
  'school_id': 'school-1',
  'class_id': 'class-1',
  'student_id': studentId,
  'status': 'active',
  'enrolled_at': _t0,
  'withdrawn_at': null,
  'created_at': _t0,
  'updated_at': _t0,
});

AttendanceRecord _record(String studentId, String status) => AttendanceRecord.fromJson({
  'id': 'rec-$studentId',
  'school_id': 'school-1',
  'attendance_session_id': 'session-1',
  'student_id': studentId,
  'status': status,
  'minutes_late': null,
  'reason': null,
  'recorded_by_user_id': 'user-1',
  'created_at': _t0,
});

void main() {
  group('AttendanceMarkStatus.next', () {
    test('cycles present -> absent -> late -> excused -> present', () {
      expect(AttendanceMarkStatus.present.next, AttendanceMarkStatus.absent);
      expect(AttendanceMarkStatus.absent.next, AttendanceMarkStatus.late);
      expect(AttendanceMarkStatus.late.next, AttendanceMarkStatus.excused);
      expect(AttendanceMarkStatus.excused.next, AttendanceMarkStatus.present);
    });
  });

  group('AttendanceMark', () {
    test('cycling into late attaches the minimum minutes-late, and away drops it', () {
      final absent = AttendanceMark.present('s1').cycled();
      expect(absent.status, AttendanceMarkStatus.absent);
      expect(absent.minutesLate, isNull);

      final late = absent.cycled();
      expect(late.status, AttendanceMarkStatus.late);
      expect(late.minutesLate, kMinMinutesLate);

      final excused = late.cycled();
      expect(excused.status, AttendanceMarkStatus.excused);
      expect(excused.minutesLate, isNull);
    });

    test('withMinutesLate floors at the API minimum', () {
      final late = AttendanceMark.present('s1').cycled().cycled().withMinutesLate(0);
      expect(late.minutesLate, kMinMinutesLate);
      expect(late.withMinutesLate(15).minutesLate, 15);
    });

    test('wireStatus maps to the batch enum', () {
      expect(AttendanceMarkStatus.present.wireStatus, BatchRecordItemStatus.present);
      expect(AttendanceMarkStatus.late.wireStatus, BatchRecordItemStatus.valueLate);
      expect(AttendanceMarkStatus.excused.wireStatus, BatchRecordItemStatus.excused);
    });
  });

  group('AttendanceMarkStatus.fromRecord', () {
    test('maps known statuses and collapses remote/unknown to present', () {
      expect(AttendanceMarkStatus.fromRecord(AttendanceRecordStatus.absent),
          AttendanceMarkStatus.absent);
      expect(AttendanceMarkStatus.fromRecord(AttendanceRecordStatus.valueLate),
          AttendanceMarkStatus.late);
      expect(AttendanceMarkStatus.fromRecord(AttendanceRecordStatus.remote),
          AttendanceMarkStatus.present);
      expect(AttendanceMarkStatus.fromRecord(AttendanceRecordStatus.$unknown),
          AttendanceMarkStatus.present);
    });
  });

  group('AttendanceTally.of', () {
    test('counts each status', () {
      final tally = AttendanceTally.of([
        const AttendanceMark(studentId: 'a', status: AttendanceMarkStatus.present),
        const AttendanceMark(studentId: 'b', status: AttendanceMarkStatus.absent),
        const AttendanceMark(studentId: 'c', status: AttendanceMarkStatus.absent),
        const AttendanceMark(studentId: 'd', status: AttendanceMarkStatus.late),
      ]);
      expect(tally.present, 1);
      expect(tally.absent, 2);
      expect(tally.late, 1);
      expect(tally.excused, 0);
      expect(tally.total, 4);
    });
  });

  group('AttendanceTakingRegister', () {
    test('editableRoster excludes students already recorded in an open session', () {
      final register = AttendanceTakingRegister(
        roster: [_enrolment('a'), _enrolment('b'), _enrolment('c')],
        lockedRecords: [_record('b', 'present')],
      );

      expect(register.lockedStudentIds, {'b'});
      expect(register.editableRoster.map((e) => e.studentId), ['a', 'c']);
    });
  });

  group('RecordedRegister.canCorrect', () {
    test('is false without a known record set', () {
      final register = RecordedRegister(
        roster: [_enrolment('a')],
        session: _submittedSession(),
        records: null,
      );
      expect(register.canCorrect, isFalse);
    });

    test('is true when records are known', () {
      final register = RecordedRegister(
        roster: [_enrolment('a')],
        session: _submittedSession(),
        records: [_record('a', 'present')],
      );
      expect(register.canCorrect, isTrue);
    });
  });
}

AttendanceSession _submittedSession() => AttendanceSession.fromJson({
  'id': 'session-1',
  'school_id': 'school-1',
  'class_id': 'class-1',
  'session_date': _t0,
  'period': null,
  'status': 'submitted',
  'taken_by_user_id': 'user-1',
  'created_at': _t0,
  'updated_at': _t0,
});
