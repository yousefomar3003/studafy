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
