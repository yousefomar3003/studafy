import '../../../core/router/route_paths.dart';
import '../../shell/domain/shell_role.dart';

/// Where tapping a notification in the inbox takes the user.
///
/// Exactly one of [route] (a screen to push) or [tabLabelKey] (a shell tab to switch to) is set;
/// when neither is, the inbox shows the notification's full text in place instead.
class NotificationTarget {
  const NotificationTarget.route(String this.route) : tabLabelKey = null;
  const NotificationTarget.tab(String this.tabLabelKey) : route = null;
  const NotificationTarget.none() : route = null, tabLabelKey = null;

  final String? route;
  final String? tabLabelKey;

  bool get isNone => route == null && tabLabelKey == null;
}

final _assignmentRoute = RegExp(r'^/courses/[^/{}]+/assignments/[^/{}]+$');
final _gradesRoute = RegExp(r'^/courses/[^/{}]+/grades$');

/// Whether [route] is a deep link this app can open on its own: a filled-in assignment or grades
/// path, or the parent alert center. Server templates for other types point at web-only pages, or
/// still hold `{placeholders}`, so anything else is not followed.
bool isOpenableNotificationRoute(String? route) {
  if (route == null || route.isEmpty) return false;
  return route == RoutePaths.parentAlerts ||
      _assignmentRoute.hasMatch(route) ||
      _gradesRoute.hasMatch(route);
}

/// The inbox's tap target for a notification of [type] (the API's `notification_type`) with
/// [metadata], for a user in [role]'s shell.
NotificationTarget notificationTargetFor({
  required String type,
  required Map<String, dynamic> metadata,
  required ShellRole role,
}) {
  final route = metadata['route'];
  final openable = route is String && isOpenableNotificationRoute(route)
      ? route
      : null;

  switch (type) {
    case 'DIRECT_MESSAGE':
      if (role == ShellRole.teacher || role == ShellRole.parent) {
        return const NotificationTarget.tab('shell.tabs.messages');
      }
    case 'ATTENDANCE_ALERT':
    case 'ATTENDANCE_MARKED':
      if (role == ShellRole.parent) {
        return const NotificationTarget.route(RoutePaths.parentAlerts);
      }
    case 'ANNOUNCEMENT':
    case 'ADMIN_ANNOUNCEMENT':
      if (role == ShellRole.parent) {
        return const NotificationTarget.tab('shell.tabs.news');
      }
    case 'FEE_INVOICE_ISSUED':
    case 'FEE_PAYMENT_RECEIVED':
    case 'FEE_PAYMENT_REMINDER':
    case 'FEE_STATEMENT':
      if (role == ShellRole.parent) {
        return const NotificationTarget.tab('shell.tabs.home');
      }
    case 'ASSIGNMENT_PUBLISHED':
    case 'ASSIGNMENT_GRADED':
    case 'ASSIGNMENT_DUE_SOON':
    case 'GRADE_POSTED':
      if (role == ShellRole.student) {
        if (openable != null) return NotificationTarget.route(openable);
        return const NotificationTarget.tab('shell.tabs.work');
      }
      if (role == ShellRole.parent) {
        return const NotificationTarget.tab('shell.tabs.children');
      }
  }
  if (openable != null && role != ShellRole.viewer) {
    return NotificationTarget.route(openable);
  }
  return const NotificationTarget.none();
}
