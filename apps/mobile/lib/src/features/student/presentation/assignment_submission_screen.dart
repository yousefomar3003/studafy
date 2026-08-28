import 'package:easy_localization/easy_localization.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_providers.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/assignment_detail_providers.dart';
import '../application/assignment_list_providers.dart';
import '../application/submission_form_controller.dart';
import '../domain/assignment_list_filter.dart';
import 'widgets/pending_attachment_tile.dart';

/// Hand-in form for one assignment: free-text content plus zero or more file attachments, each
/// with its own upload progress and retry — see [SubmissionFormController], which owns the whole
/// pipeline. Also reached for a resubmission, in which case [initialContent] pre-fills the text
/// field with the previous attempt's answer.
class AssignmentSubmissionScreen extends ConsumerStatefulWidget {
  const AssignmentSubmissionScreen({
    required this.assignmentId,
    this.initialContent = '',
    super.key,
  });

  final String assignmentId;
  final String initialContent;

  @override
  ConsumerState<AssignmentSubmissionScreen> createState() => _AssignmentSubmissionScreenState();
}

class _AssignmentSubmissionScreenState extends ConsumerState<AssignmentSubmissionScreen> {
  late final SubmissionFormController _controller;
  late final TextEditingController _textController;

  @override
  void initState() {
    super.initState();
    _controller = SubmissionFormController(
      client: ref.read(apiClientProvider).submissions,
      assignmentId: widget.assignmentId,
      initialContent: widget.initialContent,
    )..addListener(_onControllerChanged);
    _textController = TextEditingController(text: widget.initialContent);
  }

  void _onControllerChanged() {
    if (!mounted) return;
    if (_controller.state.didSubmit) {
      // Every view of this assignment's own state is now stale — the list tabs' status pills,
      // the detail screen's submission section, and this screen's own providers all read
      // through the API rather than being told the new state directly.
      ref
        ..invalidate(assignmentSubmissionProvider(widget.assignmentId))
        ..invalidate(studentAssignmentsProvider(AssignmentListFilter.due))
        ..invalidate(studentAssignmentsProvider(AssignmentListFilter.submitted))
        ..invalidate(studentAssignmentsProvider(AssignmentListFilter.graded));
      Navigator.of(context).pop(true);
      return;
    }
    setState(() {});
  }

  @override
  void dispose() {
    _controller
      ..removeListener(_onControllerChanged)
      ..dispose();
    _textController.dispose();
    super.dispose();
  }

  Future<void> _pickFiles() async {
    final result = await FilePicker.pickFiles(allowMultiple: true, withData: false);
    if (result == null) return;
    _controller.addFiles(result.files);
  }

  @override
  Widget build(BuildContext context) {
    final state = _controller.state;
    final colorScheme = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(title: Text('assignments.submission.title'.tr())),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        children: [
          TextField(
            controller: _textController,
            onChanged: _controller.updateContent,
            enabled: !state.isSubmitting,
            maxLines: 6,
            decoration: InputDecoration(
              labelText: 'assignments.submission.contentLabel'.tr(),
              hintText: 'assignments.submission.contentHint'.tr(),
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: AppSpacing.space16),
          OutlinedButton.icon(
            onPressed: state.isSubmitting ? null : _pickFiles,
            icon: const Icon(Icons.attach_file),
            label: Text('assignments.submission.addFiles'.tr()),
          ),
          if (state.attachments.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.space8),
            for (final attachment in state.attachments)
              PendingAttachmentTile(
                attachment: attachment,
                onRetry: () => _controller.retryAttachment(attachment.localId),
                onRemove: () => _controller.removeAttachment(attachment.localId),
              ),
          ],
          const SizedBox(height: AppSpacing.space24),
          if (state.submitError != null) ...[
            Text(_errorMessage(state.submitError!), style: TextStyle(color: colorScheme.error)),
            const SizedBox(height: AppSpacing.space12),
          ],
          FilledButton(
            onPressed: state.canSubmit ? _controller.submit : null,
            child: state.isSubmitting
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text('assignments.submission.submit'.tr()),
          ),
        ],
      ),
    );
  }

  String _errorMessage(SubmissionSubmitError error) => switch (error) {
    SubmissionSubmitError.closed => 'assignments.submission.errors.closed'.tr(),
    SubmissionSubmitError.attachmentsFailed =>
      'assignments.submission.errors.attachmentsFailed'.tr(),
    SubmissionSubmitError.network => 'assignments.submission.errors.network'.tr(),
    SubmissionSubmitError.unknown => 'assignments.submission.errors.unknown'.tr(),
  };
}
