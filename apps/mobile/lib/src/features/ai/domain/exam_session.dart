import 'exam.dart';

/// Mirrors `ExamSessionStatus` (`apps/api/src/modules/ai/exam/persistence.ts`): one resource,
/// evolving representation as generation, the timer, and grading each land.
enum ExamSessionStatus {
  /// Item-bank generation is running on a worker; not yet playable.
  generating,

  /// Generated and waiting on the student's deliberate "start" — the "lock-in start" moment. No
  /// items are visible yet.
  ready,

  /// The server-enforced timer is running; [ExamSession.items] is populated.
  inProgress,

  /// Graded; [ExamSession.report] is populated.
  submitted,

  /// Generation failed — see [ExamSession.failureReason].
  failed,
}

ExamSessionStatus examSessionStatusFromWire(String wire) => switch (wire) {
  'generating' => ExamSessionStatus.generating,
  'ready' => ExamSessionStatus.ready,
  'in_progress' => ExamSessionStatus.inProgress,
  'submitted' => ExamSessionStatus.submitted,
  'failed' => ExamSessionStatus.failed,
  _ => throw ArgumentError('Unknown exam session status: $wire'),
};

/// One exam session, at whatever stage of its lifecycle `ExamClient` last observed it in. Never
/// cached locally as a whole — unlike `QuizSession`, every stage is re-fetchable from the server
/// (`GET .../exams/{examId}`), so this is always freshly parsed from a response, not persisted.
/// See `ExamProgressStore` for the one thing that *is* persisted locally: the student's
/// not-yet-submitted answer draft.
class ExamSession {
  const ExamSession({
    required this.id,
    required this.status,
    required this.questionCount,
    required this.durationMinutes,
    required this.createdAt,
    this.startedAt,
    this.expiresAt,
    this.submittedAt,
    this.failureReason,
    this.items,
    this.report,
  });

  final String id;
  final ExamSessionStatus status;
  final int questionCount;
  final int durationMinutes;
  final DateTime createdAt;
  final DateTime? startedAt;

  /// The server-authoritative deadline: `submit` refuses once `now() > expiresAt` on the
  /// server's own clock, regardless of what any client believes the remaining time to be.
  final DateTime? expiresAt;
  final DateTime? submittedAt;
  final String? failureReason;

  /// Populated only at [ExamSessionStatus.inProgress] — never at [ExamSessionStatus.ready], so
  /// nothing is visible before the student commits to starting the clock.
  final List<ExamItem>? items;

  /// Populated only at [ExamSessionStatus.submitted].
  final ExamReport? report;

  factory ExamSession.fromJson(Map<String, Object?> json) {
    final itemsJson = json['items'] as List<Object?>?;
    final reportJson = json['report'] as Map<String, Object?>?;
    final startedAt = json['started_at'] as String?;
    final expiresAt = json['expires_at'] as String?;
    final submittedAt = json['submitted_at'] as String?;
    return ExamSession(
      id: json['id']! as String,
      status: examSessionStatusFromWire(json['status']! as String),
      questionCount: json['question_count']! as int,
      durationMinutes: json['duration_minutes']! as int,
      createdAt: DateTime.parse(json['created_at']! as String),
      startedAt: startedAt == null ? null : DateTime.parse(startedAt),
      expiresAt: expiresAt == null ? null : DateTime.parse(expiresAt),
      submittedAt: submittedAt == null ? null : DateTime.parse(submittedAt),
      failureReason: json['failure_reason'] as String?,
      items: itemsJson?.map((item) => ExamItem.fromJson(item! as Map<String, Object?>)).toList(),
      report: reportJson == null ? null : ExamReport.fromJson(reportJson),
    );
  }
}
