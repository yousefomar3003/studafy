import '../../../core/api/generated/models/notification.dart' as api_models;

/// Which of the parent's two communication feeds a notification belongs to.
enum ParentAlertCategory { attendance, message }

/// Classifies [notification] by its wire `notification_type` — `ATTENDANCE_ALERT` into
/// [ParentAlertCategory.attendance], `ANNOUNCEMENT` / `ADMIN_ANNOUNCEMENT` into
/// [ParentAlertCategory.message], everything else (grades, assignments, …) into neither, since
/// those already have their own dedicated surfaces.
///
/// Reads through [Enum.name] rather than the generated `notification_type` enum type itself: that
/// type is inlined three times in the OpenAPI document (on `Notification`, `NotificationPreference`
/// and `NotificationPreferenceUpdate`), so `swagger_parser` gives it an unstable, numbered class
/// name per generation run — see the collision note on `lib/src/core/api/README.md`. `.name`
/// always yields the lowerCamelCase form of the wire value regardless of which class won that
/// collision, so this never has to name the type.
ParentAlertCategory? categoryOf(api_models.Notification notification) {
  switch (notification.notificationType.name) {
    case 'attendanceAlert':
      return ParentAlertCategory.attendance;
    case 'announcement':
    case 'adminAnnouncement':
      return ParentAlertCategory.message;
    default:
      return null;
  }
}
