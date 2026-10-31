import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/status12.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/features/student/application/assignment_list_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/assignment_list_filter.dart';

// The teacher feature's fakes already model the assignments and submissions clients; the student
// list screen reads the same two endpoints, so they are reused rather than duplicated.
import '../../teacher/support.dart';

/// A student's assignment list ignores `classId` — the API scopes it to the caller's classes — so
/// this fake answers by `status` instead of the class-keyed teacher fake.
class _StudentAssignmentsClient extends FakeAssignmentsClient {
  _StudentAssignmentsClient(this.byStatus);

  final Map<Status12, List<Assignment>> byStatus;

  @override
  Future<AssignmentList> listAssignments({
    String? cursor,
    String? classId,
    String? subjectId,
    Status12? status,
    int? limit = 20,
  }) async => AssignmentList(
    assignments: byStatus[status] ?? const [],
    nextCursor: null,
  );
}

ProviderContainer _container(FakeStudafyApiClient api) {
  final container = ProviderContainer(
    overrides: [apiClientProvider.overrideWithValue(api)],
  );
  addTearDown(container.dispose);
  return container;
}

FakeStudafyApiClient _api() => FakeStudafyApiClient(
  assignments: _StudentAssignmentsClient({
    Status12.submitted: [
      assignmentFixture(id: 'a1', classId: 'c1', title: 'Essay'),
      assignmentFixture(id: 'a2', classId: 'c1', title: 'Quiz'),
      assignmentFixture(id: 'a3', classId: 'c2', title: 'Lab'),
    ],
  }),
  submissions: FakeSubmissionsClient(
    byAssignmentId: {
      'a1': [
        submissionFixture(id: 'sub-1', assignmentId: 'a1', studentId: 'stu-1'),
      ],
      'a2': [
        submissionFixture(
          id: 'sub-2',
          assignmentId: 'a2',
          studentId: 'stu-1',
          status: 'graded',
          gradeStatus: 'published',
          score: 9,
        ),
      ],
      // Outside the page: must not be requested, and must not be paired.
      'a9': [
        submissionFixture(id: 'sub-9', assignmentId: 'a9', studentId: 'stu-1'),
      ],
    },
  ),
);

void main() {
  group('studentAssignmentsProvider', () {
    test(
      'pairs each submitted assignment with the caller\'s submission in one call',
      () async {
        final api = _api();

        final pairs = await _container(api).read(
          studentAssignmentsProvider(AssignmentListFilter.submitted).future,
        );

        expect(pairs.map((p) => p.assignment.id), ['a1', 'a2', 'a3']);
        expect(pairs.map((p) => p.submission?.id), ['sub-1', 'sub-2', null]);
        expect(api.submissions.acrossAssignmentsCalls, [
          ['a1', 'a2', 'a3'],
        ]);
      },
    );

    test('graded narrows to released marks', () async {
      final pairs = await _container(
        _api(),
      ).read(studentAssignmentsProvider(AssignmentListFilter.graded).future);

      expect(pairs.map((p) => p.submission?.id), ['sub-2']);
    });

    test('an empty page asks for no submissions', () async {
      final api = FakeStudafyApiClient(
        assignments: _StudentAssignmentsClient(const {}),
      );

      final pairs = await _container(
        api,
      ).read(studentAssignmentsProvider(AssignmentListFilter.submitted).future);

      expect(pairs, isEmpty);
      expect(api.submissions.acrossAssignmentsCalls, isEmpty);
    });
  });
}
