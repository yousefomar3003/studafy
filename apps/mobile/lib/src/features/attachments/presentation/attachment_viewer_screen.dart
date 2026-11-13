import 'dart:io';

import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_pdfview/flutter_pdfview.dart';
import 'package:path_provider/path_provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../domain/attachment_kind.dart';

/// Hands out a working pre-signed URL for the file, renewing it when the one on screen expired.
typedef AttachmentUrlResolver = Future<String?> Function();

/// Opens an assignment or submission attachment inside the app.
///
/// PDFs, pictures and plain text are downloaded once into the app's cache (keyed by attachment id)
/// and shown here: [PDFView], a pinch-to-zoom [Image.file], or the text itself.
///
/// Word, Excel, PowerPoint and anything else open in the phone's own app for them ("Open"): an
/// in-app web view is deliberately not used -- the store-compliance suite bans `webview_flutter`
/// (child-directed app, no in-app browsing), and a native preview plugin would add media-library
/// permissions on Android. The API marks those downloads `inline`, so Safari shows a .docx on iOS
/// rather than only saving it.
///
/// "Open in another app" is always in the app bar as well. No third-party viewer service is ever
/// handed the file or its URL: school documents stay between the phone and our storage.
class AttachmentViewerScreen extends StatefulWidget {
  const AttachmentViewerScreen({
    required this.attachmentId,
    required this.fileName,
    required this.mimeType,
    required this.resolveUrl,
    this.dio,
    this.cacheDirectory,
    super.key,
  });

  final String attachmentId;
  final String fileName;
  final String mimeType;
  final AttachmentUrlResolver resolveUrl;

  /// Tests inject these; production uses a plain [Dio] (the URL is pre-signed -- no bearer) and the
  /// app's temporary directory.
  final Dio? dio;
  final Future<Directory> Function()? cacheDirectory;

  @override
  State<AttachmentViewerScreen> createState() => _AttachmentViewerScreenState();
}

class _AttachmentViewerScreenState extends State<AttachmentViewerScreen> {
  late final AttachmentKind _kind = attachmentKindOf(widget.mimeType, widget.fileName);
  Future<File>? _file;

  bool get _previewsInApp =>
      _kind == AttachmentKind.pdf || _kind == AttachmentKind.image || _kind == AttachmentKind.text;

  @override
  void initState() {
    super.initState();
    if (_previewsInApp) _file = _download();
  }

  Future<File> _download() async {
    final base = await (widget.cacheDirectory ?? getTemporaryDirectory)();
    final dir = Directory('${base.path}/attachments/${widget.attachmentId}');
    final file = File('${dir.path}/${safeLocalFileName(widget.fileName)}');
    if (await file.exists() && await file.length() > 0) return file;

    final url = await widget.resolveUrl();
    if (url == null) throw const AttachmentUnavailableException();
    final response = await (widget.dio ?? Dio()).get<List<int>>(
      url,
      options: Options(responseType: ResponseType.bytes),
    );
    await dir.create(recursive: true);
    return file.writeAsBytes(response.data!, flush: true);
  }

  Future<void> _openExternally() async {
    final url = await widget.resolveUrl();
    if (!mounted) return;
    final opened =
        url != null && await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    if (!opened && mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('attachments.viewer.openFailed'.tr())));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.fileName, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(
            key: const Key('attachmentOpenExternally'),
            tooltip: 'attachments.viewer.openExternally'.tr(),
            icon: const Icon(Icons.open_in_new),
            onPressed: _openExternally,
          ),
        ],
      ),
      body: _previewsInApp ? _preview() : _openElsewhere(),
    );
  }

  Widget _openElsewhere() {
    return _Message(
      icon: _kind == AttachmentKind.document
          ? Icons.description_outlined
          : Icons.insert_drive_file_outlined,
      text: 'attachments.viewer.noPreview'.tr(),
      action: FilledButton.icon(
        key: const Key('attachmentOpenButton'),
        onPressed: _openExternally,
        icon: const Icon(Icons.open_in_new),
        label: Text('attachments.viewer.open'.tr()),
      ),
    );
  }

  Widget _preview() {
    return FutureBuilder<File>(
      future: _file,
      builder: (context, snapshot) {
        if (snapshot.hasError) {
          return _Message(
            icon: Icons.error_outline,
            text: snapshot.error is AttachmentUnavailableException
                ? 'attachments.viewer.unavailable'.tr()
                : 'attachments.viewer.downloadError'.tr(),
            action: OutlinedButton(
              onPressed: () => setState(() => _file = _download()),
              child: Text('attachments.viewer.retry'.tr()),
            ),
          );
        }
        if (!snapshot.hasData) return const Center(child: CircularProgressIndicator());
        final file = snapshot.data!;
        switch (_kind) {
          case AttachmentKind.pdf:
            return PDFView(filePath: file.path);
          case AttachmentKind.image:
            return InteractiveViewer(
              maxScale: 5,
              child: Center(child: Image.file(file, fit: BoxFit.contain)),
            );
          case AttachmentKind.text:
          case AttachmentKind.document:
          case AttachmentKind.other:
            return FutureBuilder<String>(
              future: file.readAsString().catchError((_) => ''),
              builder: (context, text) => SingleChildScrollView(
                padding: const EdgeInsets.all(16),
                child: SelectableText(text.data ?? ''),
              ),
            );
        }
      },
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.text, required this.action});

  final IconData icon;
  final String text;
  final Widget action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 40, color: Theme.of(context).colorScheme.onSurfaceVariant),
            const SizedBox(height: 12),
            Text(text, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            action,
          ],
        ),
      ),
    );
  }
}

/// The resolver had no URL to give: the file isn't (or is no longer) downloadable.
class AttachmentUnavailableException implements Exception {
  const AttachmentUnavailableException();
}

/// The uploaded name as a single safe path segment for the local cache: no separators, no leading
/// dots, never empty. The extension is kept.
@visibleForTesting
String safeLocalFileName(String name) {
  final cleaned = name
      .replaceAll(RegExp(r'[/\\:\x00-\x1f]'), '_')
      .replaceFirst(RegExp(r'^\.+'), '');
  return cleaned.isEmpty ? 'file' : cleaned;
}
