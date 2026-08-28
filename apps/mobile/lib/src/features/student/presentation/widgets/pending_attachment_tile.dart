import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/pending_attachment.dart';
import 'file_size.dart';

/// One locally-picked file in the submission form, with its upload state: a progress bar while
/// [PendingAttachment.status] is [UploadStatus.uploading], a spinner while [UploadStatus.confirming]
/// (no byte-level progress for that step — it's a small JSON call, not a transfer), a retry
/// affordance on [UploadStatus.failed], and a remove affordance while it's safe to remove.
class PendingAttachmentTile extends StatelessWidget {
  const PendingAttachmentTile({
    required this.attachment,
    required this.onRetry,
    required this.onRemove,
    super.key,
  });

  final PendingAttachment attachment;
  final VoidCallback onRetry;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final status = attachment.status;
    final canRemove = status == UploadStatus.queued || status == UploadStatus.failed;
    final isTransferring = status == UploadStatus.uploading || status == UploadStatus.confirming;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(_iconFor(status), size: 20, color: _colorFor(status, colorScheme)),
              const SizedBox(width: AppSpacing.space8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      attachment.fileName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.bodyMedium,
                    ),
                    Text(
                      formatFileSize(attachment.sizeBytes),
                      style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
              if (status == UploadStatus.failed)
                IconButton(
                  icon: const Icon(Icons.refresh),
                  tooltip: 'assignments.submission.retry'.tr(),
                  onPressed: onRetry,
                ),
              if (canRemove)
                IconButton(
                  icon: const Icon(Icons.close),
                  tooltip: 'assignments.submission.remove'.tr(),
                  onPressed: onRemove,
                ),
            ],
          ),
          if (isTransferring) ...[
            const SizedBox(height: AppSpacing.space4),
            LinearProgressIndicator(
              value: status == UploadStatus.confirming ? null : attachment.progress,
            ),
          ],
          if (status == UploadStatus.failed && attachment.error != null) ...[
            const SizedBox(height: AppSpacing.space4),
            Text(attachment.error!, style: textTheme.bodySmall?.copyWith(color: colorScheme.error)),
          ],
        ],
      ),
    );
  }

  IconData _iconFor(UploadStatus status) => switch (status) {
    UploadStatus.queued => Icons.insert_drive_file_outlined,
    UploadStatus.uploading || UploadStatus.confirming => Icons.cloud_upload_outlined,
    UploadStatus.uploaded => Icons.check_circle_outline,
    UploadStatus.failed => Icons.error_outline,
  };

  Color _colorFor(UploadStatus status, ColorScheme colorScheme) => switch (status) {
    UploadStatus.failed => colorScheme.error,
    UploadStatus.uploaded => colorScheme.primary,
    _ => colorScheme.onSurfaceVariant,
  };
}
