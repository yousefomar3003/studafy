import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment.dart';
import 'package:studafy_mobile/src/core/api/generated/models/exam.dart';
import 'package:studafy_mobile/src/core/api/generated/models/exam_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/status14.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/features/teacher/application/teacher_agenda_providers.dart';
import 'package:studafy_mobile/src/features/teacher/application/teacher_providers.dart';

import '../support.dart';

Exam _exam(
  String id, {
  required DateTime startsAt,
  String status = 'scheduled',
}) => Exam.fromJson({
  'id': id,
  'school_id': 'school-1',
  'class_id': 'class-1',
  'created_by_user_id': 'teacher-1',
  'last_edited_by_user_id': 'teacher-1',
  'title': 'Exam $id',
  'description': null,
  'status': status,
  'starts_at': startsAt.toUtc().toIso8601String(),
  'ends_at': startsAt.add(const Duration(hours: 1)).toUtc().toIso8601String(),
  'max_score': 100,
  'room_id': null,
  'weight': 1,
  'created_at': '2026-01-01T00:00:00.000Z',
  'updated_at': '2026-01-01T00:00:00.000Z',
});

class _ExamsAcademicsClient extends FakeAcademicsClient {
  _ExamsAcademicsClient(this.exams);

  final List<Exam> exams;

  @override
  Future<ExamList> listExams({
    required String classId,
    Status14? status,
    int? limit = 20,
    int? offset = 0,
  }) async => ExamList(exams: exams, total: exams.length);
}

Assignment _assignment(
  String id, {
  required String status,
  required Duration dueIn,
}) => Assignment.fromJson({
  ...assignmentFixture(id: id, classId: 'class-1', status: status).toJson(),
  'due_at': DateTime.now().add(dueIn).toUtc().toIso8601String(),
});

void main() {
  test(
    'upcoming exams: scheduled or open, not ended, within two weeks, soonest first',
    () async {
      final now = DateTime.now();
      final container = ProviderContainer(
        overrides: [
          teacherClassesProvider.overrideWith(
            (ref) async => [classFixture(id: 'class-1', code: 'MATH101-A')],
          ),
          apiClientProvider.overrideWithValue(
            FakeStudafyApiClient(
              academics: _ExamsAcademicsClient([
                _exam('later', startsAt: now.add(const Duration(days: 5))),
                _exam(
                  'soon',
                  startsAt: now.add(const Duration(days: 1)),
                  status: 'open',
                ),
                _exam('far', startsAt: now.add(const Duration(days: 30))),
                _exam('past', startsAt: now.subtract(const Duration(days: 2))),
                _exam(
                  'cancelled',
                  startsAt: now.add(const Duration(days: 2)),
                  status: 'cancelled',
                ),
              ]),
            ),
          ),
        ],
      );
      addTearDown(container.dispose);

      final exams = await container.read(teacherUpcomingExamsProvider.future);
      expect([for (final entry in exams) entry.exam.id], ['soon', 'later']);
      expect(exams.first.classCode, 'MATH101-A');
    },
  );

  test(
    'open work is published and still due; drafts are counted separately',
    () async {
      final container = ProviderContainer(
        overrides: [
          teacherAssignmentsProvider.overrideWith(
            (ref) async => [
              _assignment(
                'later',
                status: 'published',
                dueIn: const Duration(days: 3),
              ),
              _assignment(
                'closed',
                status: 'published',
                dueIn: const Duration(days: -1),
              ),
              _assignment(
                'soon',
                status: 'published',
                dueIn: const Duration(hours: 5),
              ),
              _assignment(
                'draft',
                status: 'draft',
                dueIn: const Duration(days: 2),
              ),
            ],
          ),
        ],
      );
      addTearDown(container.dispose);

      final open = await container.read(teacherOpenWorkProvider.future);
      expect([for (final a in open) a.id], ['soon', 'later']);
      final drafts = await container.read(
        teacherDraftAssignmentsProvider.future,
      );
      expect([for (final a in drafts) a.id], ['draft']);
    },
  );
}
