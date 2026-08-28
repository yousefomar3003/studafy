import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'file_size.dart';

/// One downloadable file — an assignment attachment or a submission attachment; both generated
/// models carry the same three fields this needs, so it takes them directly rather than coupling
/// to either type.
///
/// Opens [downloadUrl] in an external app (browser, PDF viewer, ...) rather than downloading
/// in-app: the URL is a short-lived pre-signed GET (see `AssignmentAttachment.downloadUrl`'s doc
/// comment) that any app capable of handling the content type can already fetch directly.
class AttachmentDownloadTile extends StatelessWidget {
  const AttachmentDownloadTile({
    required this.fileName,
    required this.sizeBytes,
    required this.downloadUrl,
    super.key,
  });

  final String fileName;
  final int sizeBytes;

  /// Null when object storage isn't configured for this deployment — see the doc comment on
  /// either generated attachment model's `downloadUrl` field.
  final String? downloadUrl;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final url = downloadUrl;

    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(Icons.attach_file, color: colorScheme.primary),
      title: Text(fileName, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(formatFileSize(sizeBytes)),
      trailing: url == null ? null : const Icon(Icons.download_outlined),
      onTap: url == null
          ? null
          : () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
      enabled: url != null,
      minVerticalPadding: 0,
      subtitleTextStyle: Theme.of(
        context,
      ).textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
    );
  }
}
