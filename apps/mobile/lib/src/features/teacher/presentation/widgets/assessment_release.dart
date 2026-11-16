import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../student/presentation/widgets/status_pill.dart';
import '../../application/mark_sheet_providers.dart';
import '../../domain/mark_sheet.dart';
import 'mark_sheet_common.dart';

/// Where one assessment's marks stand with students and parents: released (approved on its own or
/// with its whole period), awaiting approval, or returned. Nothing for a draft.
class AssessmentReleasePill extends StatelessWidget {
  const AssessmentReleasePill({required this.assessment, super.key});

  final MarkSheetAssessment assessment;

  @override
  Widget build(BuildContext context) {
    if (assessment.released) {
      return StatusPill(
        label: 'teacher.marks.release.status.released'.tr(),
        tone: StatusPillTone.success,
      );
    }
    return switch (assessment.releaseStatus) {
      AssessmentReleaseStatus.draft ||
      AssessmentReleaseStatus.approved => const SizedBox.shrink(),
      AssessmentReleaseStatus.submitted => StatusPill(
        label: 'teacher.marks.release.status.submitted'.tr(),
        tone: StatusPillTone.warning,
      ),
      AssessmentReleaseStatus.returned => StatusPill(
        label: 'teacher.marks.release.status.returned'.tr(),
        tone: StatusPillTone.danger,
      ),
      AssessmentReleaseStatus.unknown => StatusPill(
        label: 'teacher.marks.sheet.lockedUnknown'.tr(),
        tone: StatusPillTone.warning,
      ),
    };
  }
}

/// Send [assessment]'s marks for approval on their own, after the teacher confirms. Reloads the
/// sheet either way and reports the outcome in a snack bar. [onBusy] is told when the request
/// starts (after the confirmation) and ends. Returns whether it was sent.
Future<bool> sendAssessmentForApproval({
  required BuildContext context,
  required WidgetRef ref,
  required MarkSheetKey sheetKey,
  required MarkSheetAssessment assessment,
  ValueChanged<bool>? onBusy,
}) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(
        'teacher.marks.release.confirmTitle'.tr(
          namedArgs: {'assessment': assessment.name},
        ),
      ),
      content: Text('teacher.marks.release.confirmBody'.tr()),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: Text(
            MaterialLocalizations.of(dialogContext).cancelButtonLabel,
          ),
        ),
        FilledButton(
          key: const ValueKey('release-confirm'),
          onPressed: () => Navigator.of(dialogContext).pop(true),
          child: Text('teacher.marks.release.confirm'.tr()),
        ),
      ],
    ),
  );
  if (confirmed != true || !context.mounted) return false;

  final messenger = ScaffoldMessenger.of(context);
  onBusy?.call(true);
  AssessmentReleaseStatus? status;
  DioException? failure;
  try {
    status = await ref
        .read(markSheetClientProvider)
        .submitAssessmentRelease(
          sheetKey.sectionId,
          sheetKey.subjectId,
          assessmentId: assessment.id,
        );
  } on DioException catch (error) {
    failure = error;
  }
  // Re-read either way: the release (or the missing marks) changed server-side.
  try {
    await ref.read(markSheetProvider(sheetKey).notifier).reload();
  } catch (_) {
    // The snack bar below reports the send; a failed refresh is retried by pull-to-refresh.
  }
  onBusy?.call(false);

  final message = failure == null
      ? (status == AssessmentReleaseStatus.approved
            ? 'teacher.marks.release.releasedNow'.tr()
            : 'teacher.marks.release.sent'.tr())
      : switch (markErrorCode(failure)) {
          'RESULTS_INCOMPLETE' => 'teacher.marks.release.incompleteError'.tr(),
          'CONFLICT_STATE_MISMATCH' => 'teacher.marks.release.alreadySent'.tr(),
          _ => markErrorMessage(failure),
        };
  messenger
    ..clearSnackBars()
    ..showSnackBar(SnackBar(content: Text(message)));
  return failure == null;
}

/// The release panel at the top of an assessment's mark entry: its state with students and
/// parents, the reviewer's reason when it came back, and "Send for approval" once every enrolled
/// student has a usable mark for it.
class AssessmentReleaseCard extends StatelessWidget {
  const AssessmentReleaseCard({
    required this.sheet,
    required this.assessment,
    required this.hasUnsavedChanges,
    required this.sending,
    required this.onSend,
    super.key,
  });

  final MarkSheet sheet;
  final MarkSheetAssessment assessment;
  final bool hasUnsavedChanges;
  final bool sending;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final locale = context.locale.toString();
    String date(DateTime value) =>
        DateFormat.yMMMd(locale).format(value.toLocal());
    final missing = assessment.missingCount ?? 0;
    final canSend = sheet.canSendForApproval(assessment);
    final showSend = sheet.isAssessmentEditable(assessment);

    final String message;
    if (assessment.released) {
      message = assessment.releaseDecidedAt != null
          ? 'teacher.marks.release.releasedOn'.tr(
              namedArgs: {'date': date(assessment.releaseDecidedAt!)},
            )
          : 'teacher.marks.release.released'.tr();
    } else if (assessment.releaseStatus == AssessmentReleaseStatus.submitted) {
      message = 'teacher.marks.release.lockedSubmitted'.tr();
    } else if (assessment.releaseStatus == AssessmentReleaseStatus.returned) {
      final reason = assessment.releaseReturnReason?.trim() ?? '';
      message = reason.isEmpty
          ? 'teacher.marks.release.returnedNoReason'.tr()
          : 'teacher.marks.release.returned'.tr(namedArgs: {'reason': reason});
    } else if (!showSend) {
      message = 'teacher.marks.release.withPeriod'.tr();
    } else if (missing > 0) {
      message = 'teacher.marks.release.incomplete'.tr(
        namedArgs: {'count': '$missing'},
      );
    } else {
      message = 'teacher.marks.release.ready'.tr();
    }

    return Card(
      key: const ValueKey('assessment-release-card'),
      margin: const EdgeInsets.only(bottom: AppSpacing.space12),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    'teacher.marks.release.title'.tr(),
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                AssessmentReleasePill(assessment: assessment),
              ],
            ),
            const SizedBox(height: AppSpacing.space8),
            Text(message, style: theme.textTheme.bodyMedium),
            if (showSend && hasUnsavedChanges && canSend) ...[
              const SizedBox(height: AppSpacing.space8),
              Text(
                'teacher.marks.release.saveFirst'.tr(),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            if (showSend) ...[
              const SizedBox(height: AppSpacing.space12),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  key: const ValueKey('assessment-release-send'),
                  onPressed: canSend && !hasUnsavedChanges && !sending
                      ? onSend
                      : null,
                  icon: sending
                      ? const SizedBox.square(
                          dimension: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.send_outlined),
                  label: Text('teacher.marks.release.send'.tr()),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
