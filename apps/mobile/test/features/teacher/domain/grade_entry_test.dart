import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/teacher/domain/grade_entry.dart';

const _t0 = '2026-01-01T00:00:00.000Z';

Map<String, Object?> _cell(
  String id,
  String label, {
  num? score,
  num maxScore = 100,
  num weight = 1,
}) =>
    {
      'id': id,
      'grade_submission_id': 'sub-of-$id',
      'label': label,
      'score': score,
      'max_score': maxScore,
      'weight': weight,
      'created_at': _t0,
      'updated_at': _t0,
    };

GradeSubmission _submission(
  String id,
  String studentId, {
  String status = 'draft',
  List<Map<String, Object?>> cells = const [],
}) =>
    GradeSubmission.fromJson({
      'id': id,
      'gradebook_id': 'gb-1',
      'student_id': studentId,
      'status': status,
      'rejection_reason': null,
      'submitted_by_user_id': null,
      'decided_by_user_id': null,
      'submitted_at': null,
      'decided_at': null,
      'created_at': _t0,
      'updated_at': _t0,
      'grades': cells,
    });

void main() {
  group('GradeSubmissionStatus', () {
    test('only draft is editable; submitted/approved/published are locked', () {
      expect(GradeSubmissionStatus.draft.isEditable, isTrue);
      expect(GradeSubmissionStatus.submitted.isEditable, isFalse);
      expect(GradeSubmissionStatus.submitted.isLocked, isTrue);
      expect(GradeSubmissionStatus.approved.isLocked, isTrue);
      expect(GradeSubmissionStatus.published.isLocked, isTrue);
      expect(GradeSubmissionStatus.rejected.isLocked, isFalse);
      expect(GradeSubmissionStatus.rejected.isRejected, isTrue);
    });

    test('an unknown wire value is treated as locked, never editable', () {
      final status = GradeSubmissionStatus.fromWire('some_new_state');
      expect(status, GradeSubmissionStatus.unknown);
      expect(status.isEditable, isFalse);
      expect(status.isLocked, isTrue);
    });
  });

  group('GradeCell.scoreInRange', () {
    final cell = GradeCell.fromJson(_cell('g1', 'Midterm', maxScore: 50));

    test('accepts 0..max inclusive', () {
      expect(cell.scoreInRange(0), isTrue);
      expect(cell.scoreInRange(50), isTrue);
      expect(cell.scoreInRange(25.5), isTrue);
    });

    test('rejects negative and above-max', () {
      expect(cell.scoreInRange(-1), isFalse);
      expect(cell.scoreInRange(50.01), isFalse);
    });
  });

  group('GradeEntryGrid', () {
    test('assessments are the distinct labels across every submission, sorted', () {
      final grid = GradeEntryGrid([
        _submission('s1', 'stu-b', cells: [_cell('a', 'Midterm'), _cell('b', 'Homework 1')]),
        _submission('s2', 'stu-a', cells: [_cell('c', 'Homework 1'), _cell('d', 'Final')]),
      ]);

      expect(grid.assessments.map((a) => a.label), ['Final', 'Homework 1', 'Midterm']);
      expect(grid.studentCount, 2);
    });

    test('rowsFor slices one assessment across students, ordered by student id', () {
      final grid = GradeEntryGrid([
        _submission('s1', 'stu-charlie', cells: [_cell('a', 'Midterm', score: 40, maxScore: 50)]),
        _submission('s2', 'stu-alice', cells: [_cell('b', 'Midterm', maxScore: 50)]),
        _submission('s3', 'stu-bob', cells: [_cell('c', 'Homework 1')]),
      ]);

      final rows = grid.rowsFor('Midterm');
      expect(rows.map((r) => r.studentId), ['stu-alice', 'stu-charlie']);
      expect(rows.first.cell.maxScore, 50);
      expect(rows.first.cell.isGraded, isFalse);
      expect(rows.last.cell.score, 40);
    });

    test('submittableSubmissions are draft submissions with at least one graded cell', () {
      final grid = GradeEntryGrid([
        _submission('s1', 'a', cells: [_cell('a', 'Midterm', score: 30)]), // draft + graded
        _submission('s2', 'b', cells: [_cell('b', 'Midterm')]), // draft, nothing graded
        _submission('s3', 'c',
            status: 'submitted', cells: [_cell('c', 'Midterm', score: 20)]), // already locked
      ]);

      expect(grid.submittableSubmissions.map((s) => s.id), ['s1']);
    });
  });
}
