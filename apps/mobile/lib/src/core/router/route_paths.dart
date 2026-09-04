abstract final class RoutePaths {
  static const home = '/';
  static const login = '/login';

  /// The signed-in student's personal attendance history. Distinct from [attendance], which is
  /// a course-scoped notification deep link.
  static const studentAttendance = '/me/attendance';

  /// The signed-in student's upcoming-exams calendar.
  static const studentExams = '/me/exams';

  /// The signed-in student's Ask AI chat, grounded in their school's study materials.
  static const askAi = '/me/ask-ai';

  /// The signed-in student's AI-generated quiz player.
  static const quiz = '/me/quiz';

  /// The signed-in student's AI timed mock-exam experience. Distinct from [studentExams] (the
  /// student's calendar of real, teacher-scheduled exams) — this is the AI hub's "exam mode"
  /// feature.
  static const examMode = '/me/exam-mode';

  /// The signed-in student's AI-generated flashcard deck browser and review flow.
  static const flashcards = '/me/flashcards';

  /// The signed-in student's AI usage meter: remaining monthly budget, reset date, and the
  /// nearing-limit warning ahead of the quota hard stop. Reached by tapping the compact meter on
  /// the AI hub.
  static const aiUsage = '/me/ai/usage';

  /// The signed-in parent's attendance-alert center (opened on its Alerts tab). Not one of the
  /// server-templated deep links below — an `ATTENDANCE_ALERT` push carries no resolvable route
  /// of its own yet (its template is the course-scoped `/courses/{courseId}/attendance`, but the
  /// alert's metadata carries a student id, not a course id), so [PushService] routes that
  /// notification type here directly instead of reading `route` off the payload.
  static const parentAlerts = '/parent/alerts';

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
