import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/fetch_all_pages.dart';
import '../../../core/api/generated/models/grade_submission_body.dart';
import '../../../core/api/generated/models/submission.dart';
import '../../../core/api/generated/models/submission_grade_status.dart';
import '../../../core/api/generated/models/submission_status.dart';
import '../../../core/auth/auth_providers.dart';
import 'teacher_providers.dart';

/// Every handed-in submission for one assignment (`GET .../assignments/{id}/submissions`), keyed
/// by student id. Unsent drafts and withdrawn hand-ins are left out — there is nothing to mark.
final assignmentSubmissionsProvider = FutureProvider.autoDispose
    .family<Map<String, Submission>, String>((ref, assignmentId) async {
      final api = ref.watch(apiClientProvider);
      final submissions = await fetchAllPages((limit, offset) async {
        final page = await api.submissions.listSubmissions(
          assignmentId: assignmentId,
          limit: limit,
          offset: offset,
        );
        return (rows: page.submissions, total: page.total);
      });
      return {
        for (final submission in submissions)
          if (submission.submittedAt != null &&
              submission.status != SubmissionStatus.withdrawn)
            submission.studentId: submission,
      };
    });

/// One submission with fresh attachment download links (`GET /api/academics/submissions/{id}`).
final submissionDetailProvider = FutureProvider.autoDispose
    .family<Submission, String>((ref, submissionId) {
      return ref
          .watch(apiClientProvider)
          .submissions
          .getSubmission(submissionId: submissionId);
    });

/// A [GradeSubmissionBody] that leaves `score` out of its JSON when it is null. The generated
/// `toJson` sends every field, but the API reads an absent score as "unchanged" and rejects an
/// explicit null — so returning work that was never scored would otherwise fail. `feedback` is
/// still always sent: there, null means "clear the comment".
class SparseGradeSubmissionBody extends GradeSubmissionBody {
  const SparseGradeSubmissionBody({
    super.score,
    super.feedback,
    super.publish,
    super.returnToStudent,
  });

  @override
  Map<String, Object?> toJson() {
    final json = super.toJson();
    if (score == null) json.remove('score');
    return json;
  }
}

/// Whether [submission] carries a draft mark ready to publish.
bool isReadyToPublish(Submission submission) =>
    submission.gradeStatus == SubmissionGradeStatus.draft &&
    submission.score != null;

/// Saves a mark on one submission (`PATCH /api/academics/submissions/{id}/grade`) — a staff-only
/// draft, a published mark, or a return to the student — then reloads every view of it: the
/// assignment's list, the submission itself and the home screen's grading queue. Throws the API's
/// error on refusal (e.g. a score over the assignment's maximum).
final gradeSubmissionProvider =
    Provider<
      Future<Submission> Function({
        required Submission submission,
        required GradeSubmissionBody body,
      })
    >((ref) {
      final api = ref.watch(apiClientProvider);
      return ({required submission, required body}) async {
        final updated = await api.submissions.gradeSubmission(
          submissionId: submission.id,
          body: body,
        );
        ref
          ..invalidate(assignmentSubmissionsProvider(submission.assignmentId))
          ..invalidate(submissionDetailProvider(submission.id))
          ..invalidate(teacherPendingSubmissionsProvider);
        return updated;
      };
    });

/// Publishes every draft mark in [submissions] that is ready ([isReadyToPublish]), one request
/// each, and returns how many were published. Stops at the first refusal and rethrows it; the
/// ones already published stay published.
final publishReadyMarksProvider =
    Provider<Future<int> Function(Iterable<Submission> submissions)>((ref) {
      final grade = ref.watch(gradeSubmissionProvider);
      return (submissions) async {
        var published = 0;
        for (final submission in submissions.where(isReadyToPublish)) {
          await grade(
            submission: submission,
            body: SparseGradeSubmissionBody(
              score: submission.score,
              feedback: submission.feedback,
              publish: true,
            ),
          );
          published++;
        }
        return published;
      };
    });
