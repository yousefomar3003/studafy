abstract final class RoutePaths {
  static const home = '/';
  static const login = '/login';

  // Notification deep-link destinations.
  // Paths match the route templates in packages/notification-templates/src/registry.ts.
  static const grades = '/courses/:courseId/grades';
  static const attendance = '/courses/:courseId/attendance';
  static const announcements = '/announcements';
  static const courseDetail = '/courses/:courseId';
  static const assignmentDetail = '/courses/:courseId/assignments/:assignmentId';
  static const discussionDetail =
      '/courses/:courseId/discussions/:discussionId';
  static const groupDetail = '/groups/:groupId';
  static const certificateDetail = '/certificates/:certificateId';
  static const supportTicket = '/support/tickets/:ticketId';
}
