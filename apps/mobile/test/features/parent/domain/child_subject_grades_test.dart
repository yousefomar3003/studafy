import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_grade.dart';
import 'package:studafy_mobile/src/features/parent/domain/child_subject_grades.dart';

import '../support.dart';

PublishedGrade _row(Map<String, Object?> json) => PublishedGrade.fromJson(json);

void main() {
  test('groups rows by course, one SubjectGrades per course, sorted by course name', () {
    final subjects = groupChildSubjects([
      _row(gradeRowJson(id: 'g1', courseId: 'phys', courseName: 'Physics')),
      _row(gradeRowJson(id: 'g2', courseId: 'alg', courseName: 'Algebra')),
      _row(gradeRowJson(id: 'g3', courseId: 'phys', courseName: 'Physics', label: 'Quiz 2')),
    ]);

    expect(subjects.map((s) => s.courseName), ['Algebra', 'Physics']);
    expect(subjects.firstWhere((s) => s.courseId == 'phys').entries, hasLength(2));
  });

  test('orders entries within a subject by published time then label', () {
    final subjects = groupChildSubjects([
      _row(gradeRowJson(
        id: 'late',
        courseId: 'phys',
        courseName: 'Physics',
        label: 'Final',
        publishedAt: '2026-03-01T00:00:00.000Z',
      )),
      _row(gradeRowJson(
        id: 'early',
        courseId: 'phys',
        courseName: 'Physics',
        label: 'Quiz 1',
        publishedAt: '2026-02-01T00:00:00.000Z',
      )),
    ]);

    expect(subjects.single.entries.map((e) => e.label), ['Quiz 1', 'Final']);
  });

  test('weighted average mirrors the student weightedSubjectAverage formula', () {
    // 90/100 @ weight 2 and 70/100 @ weight 1 -> (90*2 + 70*1) / 3 = 83.33...
    final subjects = groupChildSubjects([
      _row(gradeRowJson(
        id: 'g1',
        courseId: 'phys',
        courseName: 'Physics',
        score: 90,
        weight: 2,
      )),
      _row(gradeRowJson(
        id: 'g2',
        courseId: 'phys',
        courseName: 'Physics',
        label: 'Quiz 2',
        score: 70,
        weight: 1,
      )),
    ]);

    expect(subjects.single.weightedAverage, closeTo(83.33, 0.01));
  });

  test('empty input yields no subjects', () {
    expect(groupChildSubjects(const []), isEmpty);
  });
}
