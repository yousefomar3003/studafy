import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/teacher/application/mark_entry_editor.dart';
import 'package:studafy_mobile/src/features/teacher/domain/mark_sheet.dart';

import '../mark_sheet_fixtures.dart';

MarkEntryEditor _editorFor(String assessmentId, {MarkSheet? sheet}) {
  final source = sheet ?? markSheetFixture();
  return MarkEntryEditor(
    assessment: source.assessmentById(assessmentId)!,
    sheet: source,
  );
}

const _omar = (studentId: 'st-omar', attempt: 1);
const _lina = (studentId: 'st-lina', attempt: 1);

void main() {
  test('seeds recorded marks and skips exempt students', () {
    final editor = _editorFor('a-quiz1');

    expect(editor.textFor(_lina), '18');
    expect(editor.textFor(_omar), '15');
    expect(editor.hasCell((studentId: 'st-sara', attempt: 1)), isFalse);
    expect(editor.hasChanges, isFalse);
  });

  test('a score above the maximum is an error and blocks the batch', () {
    final editor = _editorFor('a-quiz1')..setText(_omar, '25');

    expect(editor.errorFor(_omar), MarkCellError.outOfRange);
    expect(editor.hasErrors, isTrue);
    expect(editor.pendingEntries, throwsStateError);
  });

  test('a negative or non-numeric score is an error', () {
    final editor = _editorFor('a-quiz1')..setText(_omar, '-1');
    expect(editor.errorFor(_omar), MarkCellError.outOfRange);

    editor.setText(_omar, 'abc');
    expect(editor.errorFor(_omar), MarkCellError.notANumber);
  });

  test('a changed score is sent with the cell\'s concurrency token', () {
    final editor = _editorFor('a-quiz1')..setText(_omar, '17.5');

    final entries = editor.pendingEntries();
    expect(entries, hasLength(1));
    expect(entries.single.toJson(), {
      'assessment_id': 'a-quiz1',
      'student_id': 'st-omar',
      'attempt': 1,
      'status': 'graded',
      'score': 17.5,
      'remarks': null,
      'expected_updated_at': '2026-09-10T10:00:00.000Z',
    });
  });

  test('emptying a recorded score clears it with status pending', () {
    final editor = _editorFor('a-quiz1')..setText(_lina, '');

    final entry = editor.pendingEntries().single;
    expect(entry.status, 'pending');
    expect(entry.score, isNull);
    expect(entry.expectedUpdatedAt, isNotNull);
  });

  test('absent / excused / not applicable carry no score', () {
    final editor = _editorFor('a-mid')..setStatus(_omar, MarkStatus.absent);

    final entry = editor.pendingEntries().single;
    expect(entry.status, 'absent');
    expect(entry.score, isNull);
    // No mark existed, so there is no token to send.
    expect(entry.expectedUpdatedAt, isNull);
  });

  test('a new mark for an unrecorded cell is a plain graded entry', () {
    final editor = _editorFor('a-mid')..setText(_omar, '64');

    expect(editor.pendingEntries().single.score, 64);
  });

  test('a retake row writes attempt 2', () {
    final editor = _editorFor(
      'a-quiz1',
      sheet: markSheetFixture(retakePolicy: 'highest'),
    )..addRetake('st-omar');
    final retake = (studentId: 'st-omar', attempt: 2);
    editor.setText(retake, '19');

    final entry = editor.pendingEntries().single;
    expect(entry.attempt, 2);
    expect(entry.score, 19);
  });

  test(
    'reseeding after a save adopts the server values and clears dirtiness',
    () {
      final editor = _editorFor('a-quiz1')..setText(_omar, '16');
      expect(editor.isDirty(_omar), isTrue);

      final saved = markSheetJson();
      final students = saved['students']! as List<Object?>;
      final omar = students[1]! as Map<String, Object?>;
      omar['marks'] = [
        {
          'id': 'm-4',
          'assessment_id': 'a-quiz1',
          'attempt': 1,
          'status': 'graded',
          'score': 16,
          'remarks': null,
          'updated_at': '2026-09-11T10:00:00.000Z',
        },
      ];
      editor.seed(MarkSheet.fromJson(saved));

      expect(editor.isDirty(_omar), isFalse);
      expect(editor.textFor(_omar), '16');
    },
  );

  test('discardChanges restores the recorded values', () {
    final editor = _editorFor('a-quiz1')
      ..setText(_omar, '3')
      ..setStatus(_lina, MarkStatus.excused)
      ..discardChanges();

    expect(editor.hasChanges, isFalse);
    expect(editor.textFor(_omar), '15');
    expect(editor.statusFor(_lina), MarkStatus.graded);
  });
}
