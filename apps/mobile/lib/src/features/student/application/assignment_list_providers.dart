import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/status12.dart';
import '../../../core/api/generated/models/submission_grade_status.dart';
import '../../../core/auth/auth_providers.dart';
import '../domain/assignment_list_filter.dart';
import '../domain/assignment_submission_pair.dart';

/// One page's worth of assignments for [filter], paired with the caller's own submission where
/// the filter needs one.
///
/// Not offline-cached, unlike [todayAssignmentsProvider] (`today_providers.dart`): a `graded`
/// filter needs one `listSubmissions` call per assignment (see below), which the
/// cache-aside `OfflineCachedResource` policy isn't shaped for, and this screen already has its
/// own pull-to-refresh for the "no connection" case. Live-only is the honest tradeoff here, not
/// an oversight.
final studentAssignmentsProvider = FutureProvider.autoDispose
    .family<List<AssignmentSubmissionPair>, AssignmentListFilter>((ref, filter) async {
      final api = ref.watch(apiClientProvider);
      const pageSize = 50;

      switch (filter) {
        case AssignmentListFilter.due:
          // `Status12` has no single value for "not yet submitted" — `upcoming` and `past_due`
          // are the two derived states that make up "still needs action", so both are fetched
          // and merged. Neither response is trusted to be ordered (see
          // `AssignmentsOfflineRepository.dueSoon`'s same note), so sorting is done here.
          final pages = await Future.wait([
            api.assignments.listAssignments(status: Status12.upcoming, limit: pageSize),
            api.assignments.listAssignments(status: Status12.pastDue, limit: pageSize),
          ]);
          final assignments = [...pages[0].assignments, ...pages[1].assignments]
            ..sort((a, b) => a.dueAt.compareTo(b.dueAt));
          return [
            for (final assignment in assignments)
              AssignmentSubmissionPair(assignment: assignment, submission: null),
          ];

        case AssignmentListFilter.submitted:
        case AssignmentListFilter.graded:
          final page = await api.assignments.listAssignments(
            status: Status12.submitted,
            limit: pageSize,
          );
          final pairs = await Future.wait(
            page.assignments.map((assignment) async {
              // One `listSubmissions` call per assignment: the API has no "my submissions across
              // every assignment" endpoint, only a per-assignment list that a student's own call
              // is auto-scoped to their own row on. See `SubmissionsClient.listSubmissions`'s doc
              // comment. Bounded by `pageSize`, same as any other paginated list screen.
              final submissions = await api.submissions.listSubmissions(
                assignmentId: assignment.id,
                limit: 1,
              );
              final submission = submissions.submissions.isEmpty
                  ? null
                  : submissions.submissions.first;
              return AssignmentSubmissionPair(assignment: assignment, submission: submission);
            }),
          );

          // `submitted` shows everything handed in, graded or not — same overlapping-views
          // spirit as the API's own `upcoming`/`past_due`/`submitted` not being a partition.
          // `graded` narrows that same set to submissions whose mark has been released.
          if (filter == AssignmentListFilter.submitted) return pairs;
          return pairs
              .where((pair) => pair.submission?.gradeStatus == SubmissionGradeStatus.published)
              .toList();
      }
    });
