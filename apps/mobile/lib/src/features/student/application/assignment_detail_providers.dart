import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/assignment_attachment_download_state.dart';
import '../../../core/api/generated/models/submission.dart';
import '../../../core/api/generated/models/submission_attachment_download_state.dart';
import '../../../core/auth/auth_providers.dart';

/// How soon a screen showing a file still being malware-scanned asks again. A clean scan takes
/// seconds (up to ~40s when the scanner was asleep), so the row turns openable on its own.
const attachmentCheckingRefetchDelay = Duration(seconds: 8);

/// Refetch [ref]'s provider after [attachmentCheckingRefetchDelay] while [anyChecking].
void _refetchWhileChecking(Ref ref, bool anyChecking) {
  if (!anyChecking) return;
  final timer = Timer(attachmentCheckingRefetchDelay, ref.invalidateSelf);
  ref.onDispose(timer.cancel);
}

/// One assignment by id, with pre-signed download URLs for its attachments.
final assignmentDetailProvider = FutureProvider.autoDispose
    .family<Assignment, String>((ref, assignmentId) async {
      final api = ref.watch(apiClientProvider);
      final assignment = await api.assignments.getAssignment(
        assignmentId: assignmentId,
      );
      _refetchWhileChecking(
        ref,
        assignment.attachments.any(
          (a) => a.downloadState == AssignmentAttachmentDownloadState.checking,
        ),
      );
      return assignment;
    });

/// The calling student's own submission for [assignmentId], or null if they haven't handed
/// anything in yet. `listSubmissions` auto-scopes to the caller for a student, so this is never
/// at risk of returning someone else's work — see `SubmissionsClient.listSubmissions`'s doc
/// comment.
final assignmentSubmissionProvider = FutureProvider.autoDispose
    .family<Submission?, String>((ref, assignmentId) async {
      final api = ref.watch(apiClientProvider);
      final page = await api.submissions.listSubmissions(
        assignmentId: assignmentId,
        limit: 1,
      );
      final submission = page.submissions.isEmpty
          ? null
          : page.submissions.first;
      _refetchWhileChecking(
        ref,
        submission?.attachments.any(
              (a) =>
                  a.downloadState == SubmissionAttachmentDownloadState.checking,
            ) ??
            false,
      );
      return submission;
    });
