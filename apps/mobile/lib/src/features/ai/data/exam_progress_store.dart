import 'dart:convert';

import '../../../core/offline/offline_database.dart';
import '../domain/exam_draft.dart';

/// The [OfflineDatabase] cache-entry namespace this store writes into — one row per student,
/// overwritten every time a new exam is created.
const _resource = 'exam_draft';

/// Local-only persistence for [ExamDraft] — the answer draft of whichever exam is (or was last)
/// in play, keyed by student. See [ExamDraft]'s doc comment for why this is the only exam state
/// worth caching locally; everything else about a session (its status, timer, items, report) has
/// a `GET` endpoint of its own and is re-fetched fresh on every resume instead.
///
/// One slot per student, not per exam session — starting a new exam overwrites whatever was
/// here, the same "one active draft" posture `QuizProgressStore` takes.
class ExamProgressStore {
  ExamProgressStore(this._database);

  final OfflineDatabase _database;

  /// The student's draft, or null when there is none (never started, or explicitly cleared).
  Future<ExamDraft?> load(String studentId) async {
    final row = await _database.read(resource: _resource, cacheKey: studentId);
    if (row == null) return null;
    return ExamDraft.fromJson(jsonDecode(row.payload) as Map<String, Object?>);
  }

  Future<void> save(String studentId, ExamDraft draft) {
    return _database.write(
      resource: _resource,
      cacheKey: studentId,
      payload: jsonEncode(draft.toJson()),
      fetchedAt: DateTime.now().toUtc(),
    );
  }

  /// Called once an exam is submitted, fails, or is explicitly abandoned for a new one —
  /// otherwise the next launch would try to resume a session that's no longer resumable.
  Future<void> clear(String studentId) {
    return _database.deleteEntry(resource: _resource, cacheKey: studentId);
  }
}
