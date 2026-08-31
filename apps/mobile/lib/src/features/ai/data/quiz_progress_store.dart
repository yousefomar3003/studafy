import 'dart:convert';

import '../../../core/offline/offline_database.dart';
import '../domain/quiz_attempt.dart';

/// The [OfflineDatabase] cache-entry namespace this store writes into — one row per student,
/// overwritten every time a new quiz starts.
const _resource = 'quiz_session';

/// Local-only persistence for one in-flight (or just-finished) quiz session, keyed by student.
///
/// There is no `GET /api/ai/students/{id}/quizzes/{quizId}` — the generate response is the only
/// time the client ever sees a quiz's questions, options, and citations — so [QuizSession.quiz]
/// is not a cache of a server resource the way `MaterialsOfflineRepository` is; it's the only
/// copy this app ever has. That's what makes ST-230's "offline-safe abandonment" and "results
/// persist to progress" acceptance criteria concrete rather than aspirational: `QuizController`
/// writes here after every answer and every revealed result, so losing connectivity or the app
/// process mid-quiz loses nothing — the next launch reads the same session back and resumes
/// exactly where the student left off.
///
/// One slot per student, not per quiz — starting a new quiz overwrites whatever was here, the
/// same "one active draft" posture `SubmissionFormController` takes for a hand-in.
class QuizProgressStore {
  QuizProgressStore(this._database);

  final OfflineDatabase _database;

  /// The student's session, or null when there is none (never started, or explicitly cleared).
  Future<QuizSession?> load(String studentId) async {
    final row = await _database.read(resource: _resource, cacheKey: studentId);
    if (row == null) return null;
    return QuizSession.fromJson(jsonDecode(row.payload) as Map<String, Object?>);
  }

  Future<void> save(String studentId, QuizSession session) {
    return _database.write(
      resource: _resource,
      cacheKey: studentId,
      payload: jsonEncode(session.toJson()),
      fetchedAt: DateTime.now().toUtc(),
    );
  }

  /// Called when the student starts a fresh quiz or explicitly abandons the current one —
  /// otherwise the next launch would resume a session they've moved past.
  Future<void> clear(String studentId) {
    return _database.deleteEntry(resource: _resource, cacheKey: studentId);
  }
}
