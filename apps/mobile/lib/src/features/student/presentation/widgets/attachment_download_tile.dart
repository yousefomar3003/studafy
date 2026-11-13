import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../attachments/domain/attachment_kind.dart';
import '../../../attachments/presentation/attachment_viewer_screen.dart';
import 'file_size.dart';

/// One attached file -- an assignment attachment or a submission attachment; both generated models
/// carry these fields, so it takes them directly rather than coupling to either type.
///
/// Tapping opens it inside the app ([AttachmentViewerScreen]: PDFs, pictures, text and, on iPhone,
/// Office documents), with "Open in another app" there as the secondary action.
///
/// The API withholds the URL until the file passes its malware scan, and says why
/// ([availability]): while it is `checking` the row says the file is being checked for safety
/// instead of looking dead; `unavailable` says it can't be opened.
class AttachmentDownloadTile extends StatelessWidget {
  const AttachmentDownloadTile({
    required this.attachmentId,
    required this.fileName,
    required this.mimeType,
    required this.sizeBytes,
    required this.downloadUrl,
    required this.availability,
    this.downloadUrlExpiresAt,
    this.refreshUrl,
    super.key,
  });

  final String attachmentId;
  final String fileName;
  final String mimeType;
  final int sizeBytes;
  final String? downloadUrl;
  final AttachmentAvailability availability;
  final DateTime? downloadUrlExpiresAt;

  /// Refetches the owning record and returns this attachment's new URL, for when the one on screen
  /// has expired (they last minutes). Without it an expired URL is tried as-is.
  final Future<String?> Function()? refreshUrl;

  bool get _openable =>
      availability == AttachmentAvailability.ready && downloadUrl != null;

  Future<String?> _resolveUrl() async {
    final expiresAt = downloadUrlExpiresAt;
    final fresh =
        expiresAt == null ||
        expiresAt.isAfter(DateTime.now().add(const Duration(seconds: 30)));
    if (fresh || refreshUrl == null) return downloadUrl;
    return refreshUrl!();
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final checking = availability == AttachmentAvailability.checking;

    final String subtitle;
    if (_openable) {
      subtitle = formatFileSize(sizeBytes);
    } else if (checking) {
      subtitle = 'attachments.tile.checking'.tr();
    } else {
      subtitle = 'attachments.tile.unavailable'.tr();
    }

    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        _iconFor(attachmentKindOf(mimeType, fileName)),
        color: colorScheme.primary,
      ),
      title: Text(fileName, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(subtitle),
      trailing: _openable
          ? const Icon(Icons.chevron_right)
          : checking
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Icon(Icons.block, color: colorScheme.onSurfaceVariant),
      onTap: _openable
          ? () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => AttachmentViewerScreen(
                  attachmentId: attachmentId,
                  fileName: fileName,
                  mimeType: mimeType,
                  resolveUrl: _resolveUrl,
                ),
              ),
            )
          : null,
      enabled: _openable || checking,
      minVerticalPadding: 0,
      subtitleTextStyle: Theme.of(
        context,
      ).textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
    );
  }
}

IconData _iconFor(AttachmentKind kind) => switch (kind) {
  AttachmentKind.pdf => Icons.picture_as_pdf_outlined,
  AttachmentKind.image => Icons.image_outlined,
  AttachmentKind.text => Icons.article_outlined,
  AttachmentKind.document => Icons.description_outlined,
  AttachmentKind.other => Icons.attach_file,
};

/// The API's `download_state` (either generated enum's `json` value) as an [AttachmentAvailability].
/// An unknown or missing value with a URL present counts as ready.
AttachmentAvailability attachmentAvailabilityFrom(
  String? json, {
  required bool hasUrl,
}) => switch (json) {
  'ready' => AttachmentAvailability.ready,
  'checking' => AttachmentAvailability.checking,
  'unavailable' => AttachmentAvailability.unavailable,
  _ =>
    hasUrl ? AttachmentAvailability.ready : AttachmentAvailability.unavailable,
};
