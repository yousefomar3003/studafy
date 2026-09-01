import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/teacher/domain/teacher_home.dart';

import '../support.dart';

void main() {
  group('SessionAttendanceState.fromSessions', () {
    test('no session for the day is notStarted', () {
      expect(
        SessionAttendanceState.fromSessions(const [], 2),
        SessionAttendanceState.notStarted,
      );
    });

    test('a draft or open session is inProgress', () {
      expect(
        SessionAttendanceState.fromSessions(
          [attendanceSession(classId: 'c1', status: 'open', period: 2)],
          2,
        ),
        SessionAttendanceState.inProgress,
      );
    });

    test('a submitted or locked session is recorded', () {
      for (final status in ['submitted', 'locked']) {
        expect(
          SessionAttendanceState.fromSessions(
            [attendanceSession(classId: 'c1', status: status, period: 2)],
            2,
          ),
          SessionAttendanceState.recorded,
          reason: status,
        );
      }
    });

    test('a cancelled session is treated as notStarted', () {
      expect(
        SessionAttendanceState.fromSessions(
          [attendanceSession(classId: 'c1', status: 'cancelled', period: 2)],
          2,
        ),
        SessionAttendanceState.notStarted,
      );
    });

    test('only a session matching the period counts', () {
      expect(
        SessionAttendanceState.fromSessions(
          [attendanceSession(classId: 'c1', status: 'submitted', period: 5)],
          2,
        ),
        SessionAttendanceState.notStarted,
      );
    });

    test('a whole-day session (null period) counts for any period', () {
      expect(
        SessionAttendanceState.fromSessions(
          [attendanceSession(classId: 'c1', status: 'submitted')],
          2,
        ),
        SessionAttendanceState.recorded,
      );
    });

    test('only recorded stops inviting action', () {
      expect(SessionAttendanceState.notStarted.invitesAction, isTrue);
      expect(SessionAttendanceState.inProgress.invitesAction, isTrue);
      expect(SessionAttendanceState.recorded.invitesAction, isFalse);
    });
  });
}
