import 'dart:async';

import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/class_value.dart';
import 'package:studafy_mobile/src/core/api/generated/models/course.dart';
import 'package:studafy_mobile/src/core/api/generated/models/cumulative_grade_summary.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_grade.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_grade_snapshot.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_term_summary.dart';
import 'package:studafy_mobile/src/core/api/generated/models/term.dart';
import 'package:studafy_mobile/src/core/api/generated/models/term_status.dart';
import 'package:studafy_mobile/src/core/api/generated/published_grades/published_grades_client.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';
import 'package:studafy_mobile/src/core/offline/offline_providers.dart';
import 'package:studafy_mobile/src/core/offline/published_grades_offline_repository.dart';
import 'package:studafy_mobile/src/core/realtime/protocol.dart';
import 'package:studafy_mobile/src/core/realtime/realtime_providers.dart';
import 'package:studafy_mobile/src/features/student/application/current_term_provider.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';
import 'package:studafy_mobile/src/features/student/application/today_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/today_section.dart';

const _studentId = 'student-1';
const _termId = 'term-1';

Term _fakeTerm() {
  final now = DateTime(2026, 1, 1);
  return Term(
    id: _termId,
    schoolId: 'school-1',
    academicYearId: 'year-1',
    code: 'T1',
    name: 'Term 1',
    sequenceNumber: 1,
    startsOn: now,
    endsOn: now.add(const Duration(days: 90)),
    status: TermStatus.active,
    createdAt: now,
    updatedAt: now,
  );
}

PublishedGradeSnapshot _snapshot(List<PublishedGrade> grades) {
  return PublishedGradeSnapshot(
    studentId: _studentId,
    termId: _termId,
    grades: grades,
    termSummary: const PublishedTermSummary(
      termAveragePercentage: 90,
      termGpa: 3.5,
      totalCredits: 12,
      calculatedAt: null,
    ),
    cumulativeSummary: const CumulativeGradeSummary(
      cumulativeGpa: 3.5,
      totalCredits: 12,
      throughTermId: _termId,
    ),
  );
}

PublishedGrade _grade(String id) {
  return PublishedGrade(
    id: id,
    gradeSubmissionId: 'submission-$id',
    gradebookId: 'gradebook-1',
    classValue: const ClassValue(id: 'class-1', code: 'MATH101-A'),
    course: const Course(id: 'course-1', code: 'MATH101', name: 'Mathematics', creditHours: 3),
    label: 'Midterm',
    score: 85,
    maxScore: 100,
    weight: 1,
    percentage: 85,
    gradeLabel: 'A',
    gpaPoints: 4,
    publishedAt: DateTime(2026, 1, 5),
  );
}

/// Hand-written fake — [PublishedGradesClient] has exactly one method, so a mocking library
/// would buy nothing here. [snapshot] is served on every call and swapped between calls to
/// simulate the server having a new grade the next time this test asks for it.
class _FakePublishedGradesClient implements PublishedGradesClient {
  PublishedGradeSnapshot snapshot = _snapshot(const []);
  int callCount = 0;

  @override
  Future<PublishedGradeSnapshot> getPublishedGrades({
    required String studentId,
    required String termId,
  }) async {
    callCount++;
    return snapshot;
  }
}

/// Polls [condition] until it is true, rather than assuming a fixed number of event-loop turns
/// is enough for a real (if in-memory) drift round trip to settle. Fails the test instead of
/// hanging forever if [condition] never becomes true.
/// [todayGradesProvider] is `.autoDispose`, and Riverpod only keeps an autoDispose provider's
/// async work alive while something is actively watching it — a bare `container.read` (even of
/// `.future`) can be disposed mid-flight before it ever emits, the same gotcha
/// `test/core/offline/offline_providers_test.dart`'s `_keepAlive` works around for `ref.listen`.
/// Call this once per container, right after creating it, and keep the returned subscription
/// open for the rest of the test.
ProviderSubscription<AsyncValue<TodaySection<PublishedGradeSnapshot>>> _keepAlive(
  ProviderContainer container,
) {
  return container.listen(todayGradesProvider, (previous, next) {});
}

Future<void> _waitUntil(bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 5));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('condition did not become true within 5s');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

void main() {
  late OfflineDatabase database;
  late _FakePublishedGradesClient client;
  late StreamController<EventEnvelope> eventsController;
  late ProviderContainer container;

  setUp(() {
    database = OfflineDatabase(NativeDatabase.memory());
    client = _FakePublishedGradesClient();
    eventsController = StreamController<EventEnvelope>.broadcast();

    container = ProviderContainer(
      overrides: [
        currentStudentIdProvider.overrideWithValue(_studentId),
        currentTermProvider.overrideWith((ref) => _fakeTerm()),
        publishedGradesOfflineRepositoryProvider.overrideWithValue(
          PublishedGradesOfflineRepository(database: database, client: client),
        ),
        realtimeEventsProvider.overrideWith((ref) => eventsController.stream),
      ],
    );
    addTearDown(container.dispose);
    addTearDown(database.close);
    addTearDown(eventsController.close);
  });

  test('resolves TodaySectionUnavailable when the student context cannot be resolved', () async {
    final unresolvedContainer = ProviderContainer();
    addTearDown(unresolvedContainer.dispose);
    _keepAlive(unresolvedContainer);

    final section = await unresolvedContainer.read(todayGradesProvider.future);

    expect(section, isA<TodaySectionUnavailable<PublishedGradeSnapshot>>());
  });

  test('loads the current snapshot as TodaySectionReady', () async {
    _keepAlive(container);
    client.snapshot = _snapshot([_grade('g1')]);

    final section = await container.read(todayGradesProvider.future);

    expect(section, isA<TodaySectionReady<PublishedGradeSnapshot>>());
    final ready = section as TodaySectionReady<PublishedGradeSnapshot>;
    expect(ready.value.data.grades, hasLength(1));
    expect(ready.value.data.grades.single.id, 'g1');
  });

  test(
    'a grades.published event naming this student refetches without waiting for the next natural refresh',
    () async {
      _keepAlive(container);
      client.snapshot = _snapshot([_grade('g1')]);
      await container.read(todayGradesProvider.future);
      expect(client.callCount, 1);

      client.snapshot = _snapshot([_grade('g1'), _grade('g2')]);

      eventsController.add(
        EventEnvelope(
          id: 'evt-1',
          type: 'grades.published',
          room: 'school:school-1:role:STUDENT',
          payload: const {'studentId': _studentId, 'gradebookId': 'gradebook-1'},
          publishedAt: DateTime.now(),
        ),
      );

      await _waitUntil(() => client.callCount >= 2);
      await _waitUntil(() {
        final section = container.read(todayGradesProvider).value;
        return section is TodaySectionReady<PublishedGradeSnapshot> &&
            section.value.data.grades.length == 2;
      });

      final section = container.read(todayGradesProvider).value;
      final ready = section! as TodaySectionReady<PublishedGradeSnapshot>;
      expect(ready.value.data.grades.map((g) => g.id), containsAll(['g1', 'g2']));
    },
  );

  test('a grades.published event for a different student is ignored', () async {
    _keepAlive(container);
    client.snapshot = _snapshot([_grade('g1')]);
    await container.read(todayGradesProvider.future);
    expect(client.callCount, 1);

    eventsController.add(
      EventEnvelope(
        id: 'evt-2',
        type: 'grades.published',
        room: 'school:school-1:role:STUDENT',
        payload: const {'studentId': 'someone-else', 'gradebookId': 'gradebook-1'},
        publishedAt: DateTime.now(),
      ),
    );
    // Nothing to poll toward here (a correctly-filtered event never bumps callCount), so a
    // couple of real delays stand in for "long enough that a bug would have shown up by now".
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(client.callCount, 1);
  });
}
