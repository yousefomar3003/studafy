import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification.dart' as api_models;
import 'package:studafy_mobile/src/features/parent/domain/parent_alert.dart';

const _t0 = '2026-01-01T00:00:00.000Z';

api_models.Notification _notification(String notificationType) {
  return api_models.Notification.fromJson({
    'id': 'n1',
    'school_id': 'school-1',
    'user_id': 'parent-1',
    'notification_type': notificationType,
    'title': 'Title',
    'body': 'Body',
    'metadata': <String, Object?>{},
    'read_at': null,
    'created_at': _t0,
    'updated_at': _t0,
  });
}

void main() {
  group('categoryOf', () {
    test('ATTENDANCE_ALERT is the attendance category', () {
      expect(categoryOf(_notification('ATTENDANCE_ALERT')), ParentAlertCategory.attendance);
    });

    test('ANNOUNCEMENT is the message category', () {
      expect(categoryOf(_notification('ANNOUNCEMENT')), ParentAlertCategory.message);
    });

    test('ADMIN_ANNOUNCEMENT is the message category', () {
      expect(categoryOf(_notification('ADMIN_ANNOUNCEMENT')), ParentAlertCategory.message);
    });

    test('other notification types belong to neither feed', () {
      expect(categoryOf(_notification('GRADE_POSTED')), isNull);
      expect(categoryOf(_notification('ASSIGNMENT_DUE_SOON')), isNull);
    });
  });
}
