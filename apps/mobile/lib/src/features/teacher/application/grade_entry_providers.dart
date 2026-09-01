import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../data/grade_entry_client.dart';
import '../domain/grade_entry.dart';

/// [GradeEntryClient] on its own [Dio], wired identically to `createApiClient` — same base URL,
/// same bearer injection, same [ErrorMappingInterceptor]. Standalone for the same reason as
/// `askAiClientProvider`: the `Grade Entry` / `Grade Workflow` tags are excluded from codegen,
/// so the generated client's `Dio` carries no methods for them.
final gradeEntryClientProvider = Provider<GradeEntryClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return GradeEntryClient(dio);
});

/// The gradebook for a class, created empty on first access. Keyed by class id.
final gradebookForClassProvider =
    FutureProvider.family<GradebookRef, String>((ref, classId) async {
  return ref.watch(gradeEntryClientProvider).resolveGradebook(classId);
});

/// The full entry grid for a gradebook — one submission per enrolled student, each with its
/// assessment cells. Keyed by gradebook id. Pull-to-refresh / post-write `invalidate` re-runs it.
final gradeEntryGridProvider =
    FutureProvider.family<GradeEntryGrid, String>((ref, gradebookId) async {
  final submissions = await ref.watch(gradeEntryClientProvider).fetchEntry(gradebookId);
  return GradeEntryGrid(submissions);
});

// ---------------------------------------------------------------------------
// Editing controller — screen-scoped, debounced autosave
// ---------------------------------------------------------------------------

/// Where an autosave stands, for the footer indicator.
enum GradeSaveStatus { idle, pending, saving, saved, error }

/// The result of a "submit for approval" pass.
class GradeSubmitResult {
  const GradeSubmitResult({required this.submitted, required this.failed});

  final int submitted;

  /// Submission ids that could not be submitted (with the error code, if any).
  final Map<String, String?> failed;

  bool get hadFailures => failed.isNotEmpty;
}

class _CellDraft {
  _CellDraft({
    required this.text,
    required this.savedScore,
    required this.token,
    required this.maxScore,
  });

  /// The raw text in the field.
  String text;

  /// The score last confirmed by the server (null = ungraded). Used to tell a dirty cell apart.
  double? savedScore;

  /// The optimistic-concurrency token for this grade row, refreshed on every successful save.
  String token;

  /// The cell's maximum — [flush] uses it to keep an out-of-range value out of the batch even
  /// though the batch call itself has no per-cell context.
  double maxScore;
}

/// Owns the in-progress edits for one assessment column and flushes them to the API on a debounce.
///
/// A plain [ChangeNotifier], not a Riverpod notifier: this is single-owner, screen-scoped state
/// (never read outside the grade-entry screen), the precedent set by the student submission form.
/// The screen re-[seed]s it from [gradeEntryGridProvider] on every build so a pull-to-refresh
/// re-resolves the world without discarding un-flushed keystrokes.
class GradeEntryController extends ChangeNotifier {
  GradeEntryController({
    required GradeEntryClient client,
    required this.gradebookId,
    this.debounce = const Duration(milliseconds: 1200),
  }) : _client = client;

  final GradeEntryClient _client;
  final String gradebookId;
  final Duration debounce;

  final Map<String, _CellDraft> _drafts = {};
  Timer? _timer;
  bool _disposed = false;

  GradeSaveStatus _status = GradeSaveStatus.idle;
  GradeSaveStatus get status => _status;

  DateTime? _lastSavedAt;
  DateTime? get lastSavedAt => _lastSavedAt;

  /// Set when the last flush failed. `GRADE_CONCURRENT_EDIT` means the grid must be reloaded.
  String? _errorCode;
  String? get errorCode => _errorCode;

  /// Reconcile the drafts with the latest [rows] for the selected assessment: add drafts for
  /// cells not seen yet, and adopt the server's newer token/score for any cell the user has not
  /// locally edited. Never clobbers a dirty cell.
  void seed(Iterable<StudentGradeEntry> rows) {
    final liveIds = <String>{};
    for (final row in rows) {
      liveIds.add(row.cell.id);
      final existing = _drafts[row.cell.id];
      if (existing == null) {
        _drafts[row.cell.id] = _CellDraft(
          text: _formatScore(row.cell.score),
          savedScore: row.cell.score,
          token: row.cell.updatedAt,
          maxScore: row.cell.maxScore,
        );
        continue;
      }
      existing.maxScore = row.cell.maxScore;
      final isClean = _parse(existing.text) == existing.savedScore;
      if (isClean &&
          (existing.token != row.cell.updatedAt || existing.savedScore != row.cell.score)) {
        existing
          ..text = _formatScore(row.cell.score)
          ..savedScore = row.cell.score
          ..token = row.cell.updatedAt;
      }
    }
    _drafts.removeWhere((id, _) => !liveIds.contains(id));
  }

  /// Drop every in-progress edit and reset the indicator. The screen calls this after a
  /// concurrent-edit conflict so the next [seed] repopulates cleanly from a fresh grid read —
  /// the honest resolution when someone else has changed the same rows.
  void resetDrafts() {
    _timer?.cancel();
    _drafts.clear();
    _status = GradeSaveStatus.idle;
    _errorCode = null;
    _safeNotify();
  }

  /// The current field text for a cell.
  String textFor(String gradeId) => _drafts[gradeId]?.text ?? '';

  /// True when [gradeId]'s text is a number outside `0..maxScore` — blocked from saving and
  /// flagged inline.
  bool isOutOfRange(String gradeId, double maxScore) {
    final value = _parse(_drafts[gradeId]?.text ?? '');
    if (value == null) return false;
    return value < 0 || value > maxScore;
  }

  /// True when [gradeId] has an entered value that differs from what the server holds.
  bool isDirty(String gradeId) {
    final draft = _drafts[gradeId];
    if (draft == null) return false;
    return _parse(draft.text) != draft.savedScore;
  }

  int get pendingCount =>
      _drafts.entries.where((e) => _parse(e.value.text) != e.value.savedScore).length;

  /// Record a keystroke for [gradeId] and (re)arm the debounce. [maxScore] gates the save: an
  /// out-of-range value is kept in the field and shown as an error but never sent.
  void setText(String gradeId, String text, {required double maxScore}) {
    final draft = _drafts[gradeId];
    if (draft == null) return;
    draft.text = text;
    _errorCode = null;

    final value = _parse(text);
    final outOfRange = value != null && (value < 0 || value > maxScore);
    if (isDirty(gradeId) && !outOfRange) {
      _status = GradeSaveStatus.pending;
      _timer?.cancel();
      _timer = Timer(debounce, flush);
    }
    notifyListeners();
  }

  /// Flush every dirty, in-range cell now. Safe to call when there is nothing to do.
  /// Every dirty, in-range cell as a batch entry — the payload [flush] would send right now.
  List<GradeScoreEdit> _collectEdits() {
    final edits = <GradeScoreEdit>[];
    for (final entry in _drafts.entries) {
      final draft = entry.value;
      final value = _parse(draft.text);
      final isDirtyCell = value != draft.savedScore;
      final outOfRange = value != null && (value < 0 || value > draft.maxScore);
      if (!isDirtyCell || outOfRange) continue;
      edits.add(GradeScoreEdit(gradeId: entry.key, score: value, updatedAt: draft.token));
    }
    return edits;
  }

  Future<void> flush() async {
    _timer?.cancel();
    if (_disposed) return;

    final edits = _collectEdits();
    if (edits.isEmpty) {
      if (_status == GradeSaveStatus.pending) _status = GradeSaveStatus.idle;
      _safeNotify();
      return;
    }

    _status = GradeSaveStatus.saving;
    _safeNotify();

    try {
      final updated = await _client.bulkUpdateGrades(gradebookId, edits);
      for (final cell in updated) {
        final draft = _drafts[cell.id];
        if (draft == null) continue;
        draft
          ..savedScore = cell.score
          ..token = cell.updatedAt
          ..text = _parse(draft.text) == cell.score ? draft.text : _formatScore(cell.score);
      }
      _lastSavedAt = DateTime.now();
      _status = pendingCount > 0 ? GradeSaveStatus.pending : GradeSaveStatus.saved;
      _errorCode = null;
    } on DioException catch (error) {
      _status = GradeSaveStatus.error;
      _errorCode = error.apiError?.code ?? 'network';
    } catch (_) {
      _status = GradeSaveStatus.error;
      _errorCode = 'unknown';
    }
    _safeNotify();
  }

  /// Flush pending edits, then submit each of [submissions] for approval. Locks every cell on a
  /// submitted student. Returns how many went through and which failed.
  Future<GradeSubmitResult> submitAll(List<GradeSubmission> submissions) async {
    await flush();

    var submitted = 0;
    final failed = <String, String?>{};
    for (final submission in submissions) {
      try {
        await _client.submitSubmission(
          gradebookId,
          submission.id,
          updatedAt: submission.updatedAt,
        );
        submitted++;
      } on DioException catch (error) {
        failed[submission.id] = error.apiError?.code ?? 'network';
      } catch (_) {
        failed[submission.id] = 'unknown';
      }
    }
    return GradeSubmitResult(submitted: submitted, failed: failed);
  }

  @override
  void dispose() {
    _timer?.cancel();
    // Best-effort: push any last keystrokes before the screen goes away. Fired directly at the
    // client (not [flush], which no-ops once disposed) and swallowing any error — nothing is
    // listening any more.
    final pending = _collectEdits();
    _disposed = true;
    if (pending.isNotEmpty) {
      unawaited(
        _client.bulkUpdateGrades(gradebookId, pending).catchError((_) => const <GradeCell>[]),
      );
    }
    super.dispose();
  }

  void _safeNotify() {
    if (!_disposed) notifyListeners();
  }

  static double? _parse(String text) {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return null;
    return double.tryParse(trimmed);
  }

  static String _formatScore(double? score) {
    if (score == null) return '';
    if (score == score.roundToDouble()) return score.toInt().toString();
    return score.toString();
  }
}
