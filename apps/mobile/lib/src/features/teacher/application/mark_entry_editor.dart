import 'package:flutter/foundation.dart';

import '../domain/mark_sheet.dart';

/// One cell of an assessment's entry column: a student and an attempt (1, or 2 for a retake).
typedef MarkCellKey = ({String studentId, int attempt});

/// Why a cell's entered value cannot be saved.
enum MarkCellError {
  /// The field holds something that is not a number.
  notANumber,

  /// Below zero or above the assessment's maximum — the API would answer
  /// `MARK_SCORE_OUT_OF_RANGE`, so it is never sent.
  outOfRange,
}

class _CellDraft {
  _CellDraft({
    required this.original,
    required this.status,
    required this.text,
  });

  /// The mark the server last reported for this cell (null = nothing recorded).
  RecordedMark? original;

  /// The status chosen in the editor; null = no mark (cleared or never entered).
  MarkStatus? status;

  /// The raw score text, meaningful only while [status] is [MarkStatus.graded].
  String text;
}

/// The in-progress edits for one assessment's column on the mark sheet.
///
/// A plain [ChangeNotifier] owned by the entry screen, like `GradeEntryController`. Unlike grade
/// entry it does not autosave: marks are saved together with an explicit Save, so the teacher can
/// review a column (and its validation) before any of it is written. A value outside
/// `0..maxMarks` is flagged inline and blocks the save — it is never sent to the API.
class MarkEntryEditor extends ChangeNotifier {
  MarkEntryEditor({required this.assessment, required MarkSheet sheet}) {
    seed(sheet);
  }

  /// The column being edited. Refreshed by [seed] (its maximum could change on a reload).
  MarkSheetAssessment assessment;

  final Map<MarkCellKey, _CellDraft> _drafts = {};

  /// Reconcile with a fresh [sheet]: add cells for new students, adopt the server's values for
  /// every cell the teacher has not changed (and for every cell a save just wrote), and keep
  /// unsaved edits.
  void seed(MarkSheet sheet) {
    assessment = sheet.assessmentById(assessment.id) ?? assessment;
    final live = <MarkCellKey>{};
    for (final student in sheet.students) {
      if (student.isExempt) continue;
      for (final attempt in const [1, 2]) {
        final key = (studentId: student.studentId, attempt: attempt);
        final mark = student.markFor(assessment.id, attempt: attempt);
        final existing = _drafts[key];
        // Attempt 2 rows exist only when recorded, or when the teacher added a retake row.
        if (attempt == 2 && mark == null && existing == null) continue;
        live.add(key);
        if (existing == null) {
          _drafts[key] = _fromMark(mark);
          continue;
        }
        final wasClean = !_isDirty(existing);
        existing.original = mark;
        if (wasClean || !_isDirty(existing)) {
          final fresh = _fromMark(mark);
          existing
            ..status = fresh.status
            ..text = fresh.text;
        }
      }
    }
    _drafts.removeWhere((key, _) => !live.contains(key));
    notifyListeners();
  }

  /// Drop every unsaved edit (after a concurrent-edit conflict, before re-reading the sheet).
  void discardChanges() {
    for (final draft in _drafts.values) {
      final fresh = _fromMark(draft.original);
      draft
        ..status = fresh.status
        ..text = fresh.text;
    }
    _drafts.removeWhere(
      (key, draft) => key.attempt == 2 && draft.original == null,
    );
    notifyListeners();
  }

  bool hasCell(MarkCellKey key) => _drafts.containsKey(key);

  String textFor(MarkCellKey key) => _drafts[key]?.text ?? '';

  MarkStatus? statusFor(MarkCellKey key) => _drafts[key]?.status;

  RecordedMark? originalFor(MarkCellKey key) => _drafts[key]?.original;

  /// Typing a score makes the cell a graded mark; emptying it clears the mark on save.
  void setText(MarkCellKey key, String text) {
    final draft = _drafts[key];
    if (draft == null) return;
    draft.text = text;
    if (text.trim().isNotEmpty) draft.status = MarkStatus.graded;
    notifyListeners();
  }

  /// Choose how the mark counts. Null clears it. A non-graded status carries no score.
  void setStatus(MarkCellKey key, MarkStatus? status) {
    final draft = _drafts[key];
    if (draft == null) return;
    draft.status = status;
    if (status != MarkStatus.graded) draft.text = '';
    notifyListeners();
  }

  /// Open a second-attempt row for [studentId]. Callers check the subject's retake policy
  /// (`MarkSheetConfig.allowsRetake`) first; the API refuses `attempt: 2` without one.
  void addRetake(String studentId) {
    final key = (studentId: studentId, attempt: 2);
    if (_drafts.containsKey(key)) return;
    _drafts[key] = _CellDraft(
      original: null,
      status: MarkStatus.graded,
      text: '',
    );
    notifyListeners();
  }

  MarkCellError? errorFor(MarkCellKey key) {
    final draft = _drafts[key];
    if (draft == null || draft.status != MarkStatus.graded) return null;
    final trimmed = draft.text.trim();
    if (trimmed.isEmpty) return null;
    final value = double.tryParse(trimmed);
    if (value == null) return MarkCellError.notANumber;
    final inRange = value >= 0 && value <= assessment.maxMarks;
    return inRange ? null : MarkCellError.outOfRange;
  }

  bool isDirty(MarkCellKey key) {
    final draft = _drafts[key];
    return draft != null && _isDirty(draft);
  }

  /// Cells with an unsaved change, valid or not.
  int get dirtyCount => _drafts.values.where(_isDirty).length;

  bool get hasChanges => dirtyCount > 0;

  /// Any cell whose value can't be saved — the Save action is disabled while this is true.
  bool get hasErrors => _drafts.keys.any((key) => errorFor(key) != null);

  /// The batch to send: every changed cell, `pending` for a cleared one. Each carries the
  /// server's `updated_at` for its cell as `expected_updated_at`, so an edit made meanwhile by
  /// someone else fails the batch with `GRADE_CONCURRENT_EDIT` instead of being overwritten.
  ///
  /// Throws [StateError] while [hasErrors] — an out-of-range value must never reach the API.
  List<MarkEntryInput> pendingEntries() {
    if (hasErrors) {
      throw StateError('Resolve invalid marks before saving');
    }
    final entries = <MarkEntryInput>[];
    _drafts.forEach((key, draft) {
      if (!_isDirty(draft)) return;
      final effective = _effective(draft);
      if (effective == null && draft.original == null) return;
      entries.add(
        MarkEntryInput(
          assessmentId: assessment.id,
          studentId: key.studentId,
          attempt: key.attempt,
          status: effective?.status.wire ?? 'pending',
          score: effective?.score,
          remarks: effective == null ? null : draft.original?.remarks,
          expectedUpdatedAt: draft.original?.updatedAt,
        ),
      );
    });
    return entries;
  }

  static _CellDraft _fromMark(RecordedMark? mark) => _CellDraft(
    original: mark,
    status: mark?.status,
    text: mark?.status == MarkStatus.graded ? formatMarkScore(mark?.score) : '',
  );

  /// What saving [draft] would record: null for "no mark".
  static ({MarkStatus status, double? score})? _effective(_CellDraft draft) {
    final status = draft.status;
    if (status == null) return null;
    if (status != MarkStatus.graded) return (status: status, score: null);
    final trimmed = draft.text.trim();
    if (trimmed.isEmpty) return null;
    return (status: status, score: double.tryParse(trimmed));
  }

  static bool _isDirty(_CellDraft draft) {
    final effective = _effective(draft);
    final original = draft.original;
    if (effective == null) return original != null;
    if (original == null) return true;
    return effective.status != original.status ||
        effective.score != original.score;
  }
}

/// A score as the teacher typed it: "18", "17.5" — no trailing ".0".
String formatMarkScore(double? score) {
  if (score == null) return '';
  if (score == score.roundToDouble()) return score.toInt().toString();
  return score.toString();
}
