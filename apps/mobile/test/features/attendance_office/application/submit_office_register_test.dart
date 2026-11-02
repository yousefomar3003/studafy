import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/attendance_office/data/attendance_office_client.dart';
import 'package:studafy_mobile/src/features/attendance_office/domain/attendance_office.dart';
import 'package:studafy_mobile/src/features/teacher/domain/attendance_taking.dart';

import '../support.dart';

List<OfficeBatchItem> _items(int n) => [
  for (var i = 0; i < n; i++)
    OfficeBatchItem(studentId: 's$i', status: AttendanceMarkStatus.present),
];

void main() {
  final date = DateTime(2026, 10, 13);

  test('no session: opens, records, then submits', () async {
    final client = FakeAttendanceOfficeClient();
    final id = await submitOfficeRegister(
      client,
      classId: 'c1',
      date: date,
      existingSession: null,
      records: _items(3),
    );
    expect(id, 'session-c1');
    expect(client.calls, [
      'open:c1',
      'batch:session-c1:3',
      'status:session-c1:submitted',
    ]);
  });

  test('a draft session is opened first', () async {
    final draft = dailySession(classId: 'c1', status: 'draft');
    final client = FakeAttendanceOfficeClient(sessions: {'c1': draft});
    await submitOfficeRegister(
      client,
      classId: 'c1',
      date: date,
      existingSession: draft,
      records: _items(1),
    );
    expect(client.calls, [
      'status:session-c1:open',
      'batch:session-c1:1',
      'status:session-c1:submitted',
    ]);
  });

  test('records are sent in batches of at most 50', () async {
    final client = FakeAttendanceOfficeClient();
    await submitOfficeRegister(
      client,
      classId: 'c1',
      date: date,
      existingSession: null,
      records: _items(120),
    );
    expect(client.calls.where((c) => c.startsWith('batch:')), [
      'batch:session-c1:50',
      'batch:session-c1:50',
      'batch:session-c1:20',
    ]);
  });

  test(
    'an open session with everyone already recorded is just submitted',
    () async {
      final open = dailySession(classId: 'c1', status: 'open');
      final client = FakeAttendanceOfficeClient(sessions: {'c1': open});
      await submitOfficeRegister(
        client,
        classId: 'c1',
        date: date,
        existingSession: open,
        records: const [],
      );
      expect(client.calls, ['status:session-c1:submitted']);
    },
  );

  test('a cancelled session throws', () async {
    final client = FakeAttendanceOfficeClient(
      sessions: {'c1': dailySession(classId: 'c1', status: 'cancelled')},
    );
    expect(
      () => submitOfficeRegister(
        client,
        classId: 'c1',
        date: date,
        existingSession: null,
        records: _items(1),
      ),
      throwsA(isA<RegisterCancelledException>()),
    );
  });
}
