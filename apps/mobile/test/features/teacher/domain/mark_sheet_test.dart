import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/teacher/domain/mark_sheet.dart';

import '../mark_sheet_fixtures.dart';

void main() {
  group('MarkSheet.fromJson', () {
    test('parses an exempt student whose preview is null', () {
      final sheet = markSheetFixture();
      final sara = sheet.studentById('st-sara')!;

      expect(sara.isExempt, isTrue);
      expect(sara.preview, isNull);
      expect(sheet.enrolledCount, 2);
    });

    test(
      'orders terms by sequence and keeps the mark concurrency token verbatim',
      () {
        final sheet = markSheetFixture();

        expect(sheet.terms.map((t) => t.id), ['t1', 't2']);
        expect(
          sheet.studentById('st-lina')!.markFor('a-quiz1')!.updatedAt,
          '2026-09-10T10:00:00.000Z',
        );
      },
    );

    test('an incomplete preview carries only a provisional percentage', () {
      final preview = markSheetFixture().studentById('st-omar')!.preview!;

      expect(preview.isComplete, isFalse);
      expect(preview.percentage, isNull);
      expect(preview.provisionalPercentage, 72.5);
      expect(preview.gradeLabel, isNull);
    });
  });

  group('missing marks', () {
    test('are scoped to the period', () {
      final sheet = markSheetFixture();
      final omar = sheet.studentById('st-omar')!;

      expect(sheet.missingFor(omar, 't1').map((a) => a.id), ['a-mid']);
      expect(sheet.missingFor(omar, 't2').map((a) => a.id), ['a-quiz2']);
      expect(sheet.studentsMissingMarks('t1').map((s) => s.studentId), [
        'st-omar',
      ]);
    });

    test('never count an exempt student', () {
      final sheet = markSheetFixture();
      expect(sheet.missingFor(sheet.studentById('st-sara')!, 't1'), isEmpty);
    });
  });

  group('editability', () {
    test('open while the period is a draft or returned', () {
      expect(markSheetFixture().isPeriodEditable('t1'), isTrue);
      expect(
        markSheetFixture(term1Status: 'returned').isPeriodEditable('t1'),
        isTrue,
      );
    });

    test('locked once submitted or approved, or outside an active year', () {
      expect(
        markSheetFixture(term1Status: 'submitted').isPeriodEditable('t1'),
        isFalse,
      );
      expect(
        markSheetFixture(term1Status: 'approved').isPeriodEditable('t1'),
        isFalse,
      );
      expect(
        markSheetFixture(canEditMarks: false).isPeriodEditable('t1'),
        isFalse,
      );
    });

    test('an exempt student has no editable cell', () {
      final sheet = markSheetFixture();
      expect(
        sheet.isCellEditable(
          sheet.assessmentById('a-quiz1')!,
          sheet.studentById('st-sara')!,
        ),
        isFalse,
      );
    });
  });

  test('groups a period\'s assessments by category in configuration order', () {
    final groups = markSheetFixture().assessmentGroupsFor('t1');

    expect(groups.map((g) => g.category?.name), ['Quizzes', 'Exams']);
    expect(groups.first.assessments.map((a) => a.name), ['Quiz 1']);
  });

  test('MarkSheetPeriodStatus treats an unknown wire value as locked', () {
    expect(MarkSheetPeriodStatus.fromWire('archived').isLocked, isTrue);
  });
}
