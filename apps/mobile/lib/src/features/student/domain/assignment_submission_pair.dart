import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/submission.dart';

/// One assignment alongside the calling student's own submission for it, if any.
///
/// The assignments API never embeds submission state on `Assignment` itself, so anywhere the UI
/// needs both (the list screen, the detail screen) has to fetch them separately and pair them up
/// — this is that pair.
class AssignmentSubmissionPair {
  const AssignmentSubmissionPair({required this.assignment, required this.submission});

  final Assignment assignment;
  final Submission? submission;
}
