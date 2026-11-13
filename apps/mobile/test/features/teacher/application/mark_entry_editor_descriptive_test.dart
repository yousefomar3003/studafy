import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/teacher/application/mark_entry_editor.dart';
import 'package:studafy_mobile/src/features/teacher/domain/mark_sheet.dart';

import '../mark_sheet_fixtures.dart';

/// The fixture sheet as a descriptive subject: Lina's quiz is recorded as "Excellent".
MarkSheet _descriptiveSheet() {
  final json = markSheetJson();
  (json['config']! as Map<String, Object?>)['grading_method'] = 'descriptive';
  json['descriptors'] = [
    {
      'id': 'd-good',
      'position': 2,
      'label': 'Good',
      'points': 2,
      'not_achieved': false,
    },
    {
      'id': 'd-excellent',
      'position': 1,
      'label': 'Excellent',
      'points': 4,
      'not_achieved': false,
    },
  ];
  final lina =
      (json['students']! as List<Object?>).first! as Map<String, Object?>;
  final mark = (lina['marks']! as List<Object?>).first! as Map<String, Object?>;
  mark['score'] = null;
  mark['descriptor_id'] = 'd-excellent';
  // Omar has nothing recorded yet.
  final omar = (json['students']! as List<Object?>)[1]! as Map<String, Object?>;
  omar['marks'] = <Object?>[];
  return MarkSheet.fromJson(json);
}

const _lina = (studentId: 'st-lina', attempt: 1);
const _omar = (studentId: 'st-omar', attempt: 1);

void main() {
  test(
    'parses the descriptor scale highest first and recorded descriptors',
    () {
      final sheet = _descriptiveSheet();
      expect(sheet.config.isDescriptive, isTrue);
      expect(sheet.descriptors.map((d) => d.label), ['Excellent', 'Good']);
      final mark = sheet.studentById('st-lina')!.markFor('a-quiz1')!;
      expect(mark.descriptorId, 'd-excellent');
      expect(sheet.descriptorById(mark.descriptorId)?.label, 'Excellent');
    },
  );

  test('a descriptive cell holds a descriptor and is sent without a score', () {
    final sheet = _descriptiveSheet();
    final editor = MarkEntryEditor(
      assessment: sheet.assessmentById('a-quiz1')!,
      sheet: sheet,
    );

    expect(editor.descriptorFor(_lina), 'd-excellent');
    expect(editor.hasChanges, isFalse);

    editor.setDescriptor(_lina, 'd-good');
    expect(editor.errorFor(_lina), isNull);
    expect(editor.isDirty(_lina), isTrue);

    final entries = editor.pendingEntries();
    expect(entries.single.toJson(), {
      'assessment_id': 'a-quiz1',
      'student_id': 'st-lina',
      'attempt': 1,
      'status': 'graded',
      'score': null,
      'descriptor_id': 'd-good',
      'remarks': null,
      'expected_updated_at': '2026-09-10T10:00:00.000Z',
    });
  });

  test('choosing the recorded descriptor again is not a change', () {
    final sheet = _descriptiveSheet();
    final editor = MarkEntryEditor(
      assessment: sheet.assessmentById('a-quiz1')!,
      sheet: sheet,
    )..setDescriptor(_lina, 'd-good');
    editor.setDescriptor(_lina, 'd-excellent');
    expect(editor.hasChanges, isFalse);
  });

  test('clearing a descriptor removes the mark', () {
    final sheet = _descriptiveSheet();
    final editor = MarkEntryEditor(
      assessment: sheet.assessmentById('a-quiz1')!,
      sheet: sheet,
    )..setDescriptor(_omar, 'd-good');
    expect(editor.dirtyCount, 1);
    editor
      ..setDescriptor(_omar, null)
      ..setDescriptor(_lina, null);
    final entry = editor.pendingEntries().single;
    expect(entry.studentId, 'st-lina');
    expect(entry.status, 'pending');
    expect(entry.descriptorId, isNull);
  });
}
