import '../../../core/router/route_paths.dart';
import '../../shell/domain/shell_role.dart';
import '../../student/domain/work_and_grades.dart';

/// Where tapping a notification in the inbox takes the user.
///
/// Exactly one of [route] (a screen to push) or [tabLabelKey] (a shell tab to switch to) is set;
/// when neither is, the inbox shows the notification's full text in place instead.
class NotificationTarget {
  const NotificationTarget.route(String this.route)
    : tabLabelKey = null,
      workSection = null,
      gradesTab = null;
  const NotificationTarget.tab(String this.tabLabelKey, {this.workSection, this.gradesTab})
    : route = null;
  const NotificationTarget.none()
    : route = null,
      tabLabelKey = null,
      workSection = null,
      gradesTab = null;

  final String? route;
  final String? tabLabelKey;

  /// For the student's "Work & grades" tab: the section to open on, and for the grades section
  /// the tab ([gradesTab]) — a grade notice lands on its own kind of grade, not on whatever
  /// section was last open.
  final WorkAndGradesSection? workSection;
  final GradesTab? gradesTab;

  bool get isNone => route == null && tabLabelKey == null;
}

/// The student's "Work & grades" shell tab (`workAndGradesTabKey`).
const _workAndGradesTab = 'shell.tabs.workAndGrades';

final _assignmentRoute = RegExp(r'^/courses/[^/{}]+/assignments/[^/{}]+$');
final _gradesRoute = RegExp(r'^/courses/[^/{}]+/grades$');
final _classMaterialsRoute = RegExp(r'^/classes/[^/{}]+/materials$');
final _studentMarksRoute = RegExp(r'^/students/[^/{}]+/marks$');

/// Whether [route] is a deep link this app can open on its own: a filled-in assignment, grades,
/// class materials or student marks path, the parent alert center, or the parent's Student AI.
/// Server templates for other types point at web-only pages, or still hold `{placeholders}`, so
/// anything else is not followed.
bool isOpenableNotificationRoute(String? route) {
  if (route == null || route.isEmpty) return false;
  return route == RoutePaths.parentAlerts ||
      route == RoutePaths.parentStudentAi ||
      _assignmentRoute.hasMatch(route) ||
      _gradesRoute.hasMatch(route) ||
      _classMaterialsRoute.hasMatch(route) ||
      _studentMarksRoute.hasMatch(route);
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
        return type == 'ASSIGNMENT_GRADED' || type == 'GRADE_POSTED'
            ? const NotificationTarget.tab(
                _workAndGradesTab,
                workSection: WorkAndGradesSection.grades,
                gradesTab: GradesTab.assignments,
              )
            : const NotificationTarget.tab(
                _workAndGradesTab,
                workSection: WorkAndGradesSection.assignments,
              );
      }
      if (role == ShellRole.parent) {
        return const NotificationTarget.tab('shell.tabs.children');
      }
    case 'MARKS_RELEASED':
      if (role == ShellRole.student || role == ShellRole.parent) {
        if (openable != null) return NotificationTarget.route(openable);
        return role == ShellRole.parent
            ? const NotificationTarget.tab('shell.tabs.children')
            : const NotificationTarget.tab(
                _workAndGradesTab,
                workSection: WorkAndGradesSection.grades,
                gradesTab: GradesTab.exams,
              );
      }
    case 'AI_OPTIN_AVAILABLE':
    case 'AI_OPTIN_CONFIRMED':
      // Parent-only screens: another role (signed in as someone else) has nothing to open.
      return role == ShellRole.parent
          ? const NotificationTarget.route(RoutePaths.parentStudentAi)
          : const NotificationTarget.none();
    case 'MATERIAL_PUBLISHED':
      if (role == ShellRole.student) {
        if (openable != null) return NotificationTarget.route(openable);
        return const NotificationTarget.tab('shell.tabs.lessons');
      }
  }
  if (openable != null && role != ShellRole.viewer) {
    return NotificationTarget.route(openable);
  }
  return const NotificationTarget.none();
}
