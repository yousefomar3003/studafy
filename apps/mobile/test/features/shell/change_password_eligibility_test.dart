import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/shell/presentation/change_password_screen.dart';

/// Settings offers "Change password" only to accounts that sign in with a member ID and password,
/// mirroring the API: a member role and no leadership or platform role.
void main() {
  test('members can change their password', () {
    for (final role in [
      'STUDENT',
      'PARENT',
      'INSTRUCTOR',
      'ATTENDANCE_OFFICER',
    ]) {
      expect(canChangeMemberPassword([role]), isTrue, reason: role);
    }
  });

  test('Google / Microsoft accounts have no password to change', () {
    expect(canChangeMemberPassword(['ORG_ADMIN']), isFalse);
    expect(canChangeMemberPassword(['FINANCE']), isFalse);
    expect(canChangeMemberPassword(['INSTRUCTOR', 'PRINCIPAL']), isFalse);
    expect(canChangeMemberPassword([]), isFalse);
  });
}
