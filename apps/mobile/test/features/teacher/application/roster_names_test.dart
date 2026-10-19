import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/attendance_office/application/attendance_office_providers.dart';
import 'package:studafy_mobile/src/features/teacher/application/teacher_providers.dart';

import '../../attendance_office/support.dart';

void main() {
  test(
    'a class roster load resolves its students\' names for teacher rows',
    () async {
      final container = ProviderContainer(
        overrides: [
          attendanceOfficeClientProvider.overrideWithValue(
            FakeAttendanceOfficeClient(names: const {'s1': 'Sara Ahmed'}),
          ),
        ],
      );
      addTearDown(container.dispose);

      expect(container.read(rosterStudentNameProvider('s1')), isNull);
      await container.read(classRosterNamesProvider('class-1').future);
      expect(container.read(rosterStudentNameProvider('s1')), 'Sara Ahmed');
      expect(container.read(rosterStudentNameProvider('unknown')), isNull);
    },
  );

  test('a failed roster load leaves rows on their short-id fallback', () async {
    final client = FakeAttendanceOfficeClient(names: const {'s1': 'Sara Ahmed'})
      ..namesFail = true;
    final container = ProviderContainer(
      overrides: [attendanceOfficeClientProvider.overrideWithValue(client)],
    );
    addTearDown(container.dispose);

    expect(
      await container.read(classRosterNamesProvider('class-1').future),
      isEmpty,
    );
    expect(container.read(rosterStudentNameProvider('s1')), isNull);
  });
}
