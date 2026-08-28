import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/class_value.dart';
import 'package:studafy_mobile/src/core/api/generated/models/course.dart';
import 'package:studafy_mobile/src/core/api/generated/models/cumulative_grade_summary.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_grade.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_grade_snapshot.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_term_summary.dart';
import 'package:studafy_mobile/src/core/api/generated/models/term.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';
import 'package:studafy_mobile/src/features/student/application/grade_providers.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/grade_report.dart';

const _studentId = 'student-1';

Term _term(String id, {required int sequence, required String status}) {
  return Term.fromJson({
    'id': id,
    'school_id': 'school-1',
    'academic_year_id': 'year-1',
    'code': 'T$sequence',
    'name': 'Term $sequence',
    'sequence_number': sequence,
    'starts_on': '2026-01-01',
    'ends_on': '2026-04-01',
    'status': status,
    'created_at': '2026-01-01T00:00:00.000Z',
    'updated_at': '2026-01-01T00:00:00.000Z',
  });
}

PublishedGrade _grade({
  required String id,
  required String courseId,
  required String courseName,
  String label = 'Quiz',
  num? score = 80,
  num maxScore = 100,
  num weight = 1,
  num? percentage = 80,
  String? gradeLabel = 'B',
  DateTime? publishedAt,
}) {
  return PublishedGrade(
    id: id,
    gradeSubmissionId: 'sub-$id',
    gradebookId: 'gb-$courseId',
    classValue: ClassValue(id: 'class-$courseId', code: '${courseName.toUpperCase()}-A'),
    course: Course(id: courseId, code: courseId.toUpperCase(), name: courseName, creditHours: 3),
    label: label,
    score: score,
    maxScore: maxScore,
    weight: weight,
    percentage: percentage,
    gradeLabel: gradeLabel,
    gpaPoints: 3,
    publishedAt: publishedAt ?? DateTime(2026, 2, 1),
  );
}

PublishedGradeSnapshot _snapshot(String termId, List<PublishedGrade> grades) {
  return PublishedGradeSnapshot(
    studentId: _studentId,
    termId: termId,
    grades: grades,
    termSummary: const PublishedTermSummary(
      termAveragePercentage: 88,
      termGpa: 3.4,
      totalCredits: 12,
      calculatedAt: null,
    ),
    cumulativeSummary: const CumulativeGradeSummary(
      cumulativeGpa: 3.3,
      totalCredits: 24,
      throughTermId: 'term-2',
    ),
  );
}

CachedValue<PublishedGradeSnapshot> _cached(PublishedGradeSnapshot snapshot) {
  return CachedValue(
    data: snapshot,
    fetchedAt: DateTime(2026, 2, 2),
    source: CacheSource.network,
  );
}

void _keepAlive(ProviderContainer container) {
  container.listen(gradeReportProvider, (_, __) {}, fireImmediately: true);
}

void main() {
  group('weightedSubjectAverage', () {
    test('is the weight-weighted mean of score / max_score * 100', () {
      // (0.9*2 + 0.6*1) / 3 * 100 = 80.
      final average = weightedSubjectAverage([
        _grade(id: 'a', courseId: 'c', courseName: 'Math', score: 90, maxScore: 100, weight: 2),
        _grade(id: 'b', courseId: 'c', courseName: 'Math', score: 30, maxScore: 50, weight: 1),
      ]);
      expect(average, closeTo(80, 1e-9));
    });

    test('ignores entries with no score, and is null when none are scored', () {
      expect(
        weightedSubjectAverage([
          _grade(id: 'a', courseId: 'c', courseName: 'Math', score: null, weight: 1),
        ]),
        isNull,
      );
      expect(
        weightedSubjectAverage([
          _grade(id: 'a', courseId: 'c', courseName: 'Math', score: 100, maxScore: 100, weight: 3),
          _grade(id: 'b', courseId: 'c', courseName: 'Math', score: null, weight: 5),
        ]),
        closeTo(100, 1e-9),
      );
    });
  });

  group('assembleGradeReport', () {
    test('groups by subject, sorts subjects by name and entries by publish time', () {
      final report = assembleGradeReport(
        term: _term('term-1', sequence: 1, status: 'active'),
        snapshot: _snapshot('term-1', [
          _grade(
            id: 'p2',
            courseId: 'phys',
            courseName: 'Physics',
            label: 'Final',
            publishedAt: DateTime(2026, 3, 1),
          ),
          _grade(
            id: 'p1',
            courseId: 'phys',
            courseName: 'Physics',
            label: 'Midterm',
            publishedAt: DateTime(2026, 2, 1),
          ),
          _grade(id: 'm1', courseId: 'math', courseName: 'Algebra', label: 'Quiz 1'),
        ]),
      );

      expect(report.subjects.map((s) => s.courseName), ['Algebra', 'Physics']);
      expect(report.subjects[1].entries.map((e) => e.label), ['Midterm', 'Final']);
      expect(report.subjects[1].classCode, 'PHYSICS-A');
      expect(report.termSummary.termGpa, 3.4);
      expect(report.cumulativeSummary.cumulativeGpa, 3.3);
    });

    test('is empty for a term with no published grades', () {
      final report = assembleGradeReport(
        term: _term('term-1', sequence: 1, status: 'active'),
        snapshot: _snapshot('term-1', const []),
      );
      expect(report.isEmpty, isTrue);
    });
  });

  group('defaultGradeTerm', () {
    test('prefers the active term', () {
      final terms = [
        _term('t1', sequence: 1, status: 'closed'),
        _term('t2', sequence: 2, status: 'active'),
        _term('t3', sequence: 3, status: 'planned'),
      ];
      expect(defaultGradeTerm(terms).id, 't2');
    });

    test('falls back to the last term when none is active', () {
      final terms = [
        _term('t1', sequence: 1, status: 'closed'),
        _term('t2', sequence: 2, status: 'closed'),
      ];
      expect(defaultGradeTerm(terms).id, 't2');
    });
  });

  group('gradeReportProvider', () {
    test('is unavailable when the student context is unresolved', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      final status = container.read(gradeReportProvider);
      expect((status as AsyncData).value, isA<GradeReportUnavailable>());
    });

    test('is unavailable when the year has no terms', () async {
      final container = ProviderContainer(
        overrides: [
          currentStudentIdProvider.overrideWithValue(_studentId),
          academicYearTermsProvider.overrideWith((ref) async => const <Term>[]),
        ],
      );
      addTearDown(container.dispose);
      _keepAlive(container);

      await container.read(academicYearTermsProvider.future);
      final status = container.read(gradeReportProvider);
      expect((status as AsyncData).value, isA<GradeReportUnavailable>());
    });

    test('assembles the default (active) term once its snapshot resolves', () async {
      final container = ProviderContainer(
        overrides: [
          currentStudentIdProvider.overrideWithValue(_studentId),
          academicYearTermsProvider.overrideWith(
            (ref) async => [
              _term('term-1', sequence: 1, status: 'closed'),
              _term('term-2', sequence: 2, status: 'active'),
            ],
          ),
          gradeSnapshotProvider.overrideWith(
            (ref, termId) => Stream.value(
              _cached(
                _snapshot(termId, [
                  _grade(id: 'g-$termId', courseId: 'math', courseName: 'Algebra'),
                ]),
              ),
            ),
          ),
        ],
      );
      addTearDown(container.dispose);
      _keepAlive(container);

      await container.read(academicYearTermsProvider.future);
      await container.read(gradeSnapshotProvider('term-2').future);

      final status = container.read(gradeReportProvider);
      final ready = (status as AsyncData).value as GradeReportReady;
      expect(ready.value.data.term.id, 'term-2');
      expect(ready.value.data.subjects.single.courseName, 'Algebra');
    });

    test('honours an explicit term selection', () async {
      final container = ProviderContainer(
        overrides: [
          currentStudentIdProvider.overrideWithValue(_studentId),
          academicYearTermsProvider.overrideWith(
            (ref) async => [
              _term('term-1', sequence: 1, status: 'closed'),
              _term('term-2', sequence: 2, status: 'active'),
            ],
          ),
          gradeSnapshotProvider.overrideWith(
            (ref, termId) => Stream.value(_cached(_snapshot(termId, const []))),
          ),
        ],
      );
      addTearDown(container.dispose);
      _keepAlive(container);

      await container.read(academicYearTermsProvider.future);
      container.read(selectedGradeTermProvider.notifier).select('term-1');
      await container.read(gradeSnapshotProvider('term-1').future);

      final status = container.read(gradeReportProvider);
      final ready = (status as AsyncData).value as GradeReportReady;
      expect(ready.value.data.term.id, 'term-1');
    });
  });

  group('deepLinkGradeTermProvider', () {
    test('resolves to the newest term whose snapshot holds the course', () async {
      final container = ProviderContainer(
        overrides: [
          currentStudentIdProvider.overrideWithValue(_studentId),
          academicYearTermsProvider.overrideWith(
            (ref) async => [
              _term('term-1', sequence: 1, status: 'closed'),
              _term('term-2', sequence: 2, status: 'active'),
            ],
          ),
          gradeSnapshotProvider.overrideWith((ref, termId) {
            final grades = termId == 'term-1'
                ? [_grade(id: 'g1', courseId: 'history', courseName: 'History')]
                : <PublishedGrade>[];
            return Stream.value(_cached(_snapshot(termId, grades)));
          }),
        ],
      );
      addTearDown(container.dispose);
      container.listen(deepLinkGradeTermProvider('history'), (_, __) {}, fireImmediately: true);

      await container.read(academicYearTermsProvider.future);
      await container.read(gradeSnapshotProvider('term-1').future);
      await container.read(gradeSnapshotProvider('term-2').future);

      expect(container.read(deepLinkGradeTermProvider('history')), 'term-1');
      expect(container.read(deepLinkGradeTermProvider('missing')), isNull);
    });
  });
}
