import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/submission.dart';
import '../../../core/auth/auth_providers.dart';

/// One assignment by id, with pre-signed download URLs for its attachments.
final assignmentDetailProvider = FutureProvider.autoDispose.family<Assignment, String>((
  ref,
  assignmentId,
) {
  final api = ref.watch(apiClientProvider);
  return api.assignments.getAssignment(assignmentId: assignmentId);
});

/// The calling student's own submission for [assignmentId], or null if they haven't handed
/// anything in yet. `listSubmissions` auto-scopes to the caller for a student, so this is never
/// at risk of returning someone else's work — see `SubmissionsClient.listSubmissions`'s doc
/// comment.
final assignmentSubmissionProvider = FutureProvider.autoDispose.family<Submission?, String>((
  ref,
  assignmentId,
) async {
  final api = ref.watch(apiClientProvider);
  final page = await api.submissions.listSubmissions(assignmentId: assignmentId, limit: 1);
  return page.submissions.isEmpty ? null : page.submissions.first;
});
