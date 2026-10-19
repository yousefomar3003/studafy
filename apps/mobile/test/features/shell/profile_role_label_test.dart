import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/shell/presentation/profile_tab_screen.dart';

void main() {
  test(
    'an attendance officer is labelled as one, even alongside a teaching role',
    () {
      expect(
        profileRoleLabelKey(['ATTENDANCE_OFFICER']),
        'shell.profile.roles.attendanceOfficer',
      );
      expect(
        profileRoleLabelKey(['INSTRUCTOR', 'ATTENDANCE_OFFICER']),
        'shell.profile.roles.attendanceOfficer',
      );
    },
  );
}
