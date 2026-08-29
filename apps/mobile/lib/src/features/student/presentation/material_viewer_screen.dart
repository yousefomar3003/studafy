import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_pdfview/flutter_pdfview.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/api/generated/models/material.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/materials_providers.dart';
import '../domain/material_ready_state.dart';
import 'widgets/file_size.dart';
import 'widgets/material_ready_state_pill.dart';
import 'widgets/material_type_icon.dart';

/// One material: its ready-state gate, then either an in-app preview (PDFs and images —
/// downloaded and cached on-device via [ensureMaterialDownloadedProvider]) or an "open in
/// another app" action for every other kind, via a freshly-minted pre-signed URL.
class MaterialViewerScreen extends StatelessWidget {
  const MaterialViewerScreen({required this.material, super.key});

  final Material material;

  @override
  Widget build(BuildContext context) {
    final state = materialReadyStateFromWireName(material.ingestStatus.name);

    return Scaffold(
      appBar: AppBar(title: Text(material.title)),
      body: state.isOpenable
          ? _MaterialReadyBody(material: material)
          : _NotReadyMessage(state: state),
    );
  }
}

class _NotReadyMessage extends StatelessWidget {
  const _NotReadyMessage({required this.state});

  final MaterialReadyState state;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              state == MaterialReadyState.quarantined ? Icons.block : Icons.hourglass_empty,
              size: 32,
              color: colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: AppSpacing.space12),
            MaterialReadyStatePill(state: state),
            const SizedBox(height: AppSpacing.space12),
            Text(
              _messageKeyFor(state).tr(),
              textAlign: TextAlign.center,
              style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }

  String _messageKeyFor(MaterialReadyState state) => switch (state) {
    MaterialReadyState.quarantined => 'materials.viewer.quarantined',
    MaterialReadyState.failed => 'materials.viewer.failed',
    _ => 'materials.viewer.notReadyYet',
  };
}

class _MaterialReadyBody extends StatelessWidget {
  const _MaterialReadyBody({required this.material});

  final Material material;

  @override
  Widget build(BuildContext context) {
    final kind = materialFileKindFor(material.mimeType);
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final description = material.description;

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      children: [
        Text(
          formatFileSize(material.sizeBytes),
          style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
        ),
        if (description != null && description.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.space12),
          Text(description, style: textTheme.bodyMedium),
        ],
        if (material.aiVisible) ...[
          const SizedBox(height: AppSpacing.space12),
          Text(
            'materials.viewer.aiVisible'.tr(),
            style: textTheme.bodySmall?.copyWith(color: colorScheme.primary),
          ),
        ],
        const SizedBox(height: AppSpacing.space16),
        if (kind == MaterialFileKind.pdf || kind == MaterialFileKind.image)
          _InAppPreview(materialId: material.id, kind: kind)
        else
          _ExternalOpenTile(material: material),
      ],
    );
  }
}

/// Downloads (if not already cached) and renders [materialId]'s file in-app: [PDFView] for a PDF,
/// a plain [Image.file] for an image. Both read from the same on-device cache
/// [ensureMaterialDownloadedProvider] fills, so a material opened once is available with no
/// connectivity on every later visit.
class _InAppPreview extends ConsumerWidget {
  const _InAppPreview({required this.materialId, required this.kind});

  final String materialId;
  final MaterialFileKind kind;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final fileAsync = ref.watch(ensureMaterialDownloadedProvider(materialId));
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return fileAsync.when(
      loading: () => const Padding(
        padding: EdgeInsets.symmetric(vertical: AppSpacing.space32),
        child: Center(child: CircularProgressIndicator()),
      ),
      error: (error, stackTrace) => Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.space16),
        child: Column(
          children: [
            Icon(Icons.error_outline, size: 32, color: colorScheme.error),
            const SizedBox(height: AppSpacing.space8),
            Text(
              'materials.viewer.downloadError'.tr(),
              textAlign: TextAlign.center,
              style: textTheme.bodyMedium,
            ),
            const SizedBox(height: AppSpacing.space12),
            OutlinedButton(
              onPressed: () => ref.invalidate(ensureMaterialDownloadedProvider(materialId)),
              child: Text('materials.viewer.retry'.tr()),
            ),
          ],
        ),
      ),
      data: (file) => kind == MaterialFileKind.pdf
          ? SizedBox(
              height: MediaQuery.of(context).size.height * 0.7,
              child: PDFView(filePath: file.path),
            )
          : Image.file(file, fit: BoxFit.contain),
    );
  }
}

/// A tap-to-open row for a material kind with no in-app preview: mints a fresh pre-signed URL on
/// every tap (never trusting one minted earlier in the screen's life — see
/// `materialDownloadUrlProvider`'s doc comment) and hands it to the OS, the same
/// `launchUrl(..., mode: externalApplication)` pattern `AttachmentDownloadTile` uses for
/// assignment attachments.
class _ExternalOpenTile extends ConsumerStatefulWidget {
  const _ExternalOpenTile({required this.material});

  final Material material;

  @override
  ConsumerState<_ExternalOpenTile> createState() => _ExternalOpenTileState();
}

class _ExternalOpenTileState extends ConsumerState<_ExternalOpenTile> {
  bool _opening = false;

  Future<void> _open() async {
    setState(() => _opening = true);
    try {
      final url = await ref.refresh(materialDownloadUrlProvider(widget.material.id).future);
      if (!mounted) return;
      await launchUrl(Uri.parse(url.downloadUrl), mode: LaunchMode.externalApplication);
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(materialTypeIconFor(widget.material.mimeType), color: colorScheme.primary),
      title: Text('materials.viewer.openExternally'.tr()),
      subtitle: Text('materials.viewer.noPreview'.tr()),
      trailing: _opening
          ? const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.download_outlined),
      enabled: !_opening,
      onTap: _opening ? null : _open,
    );
  }
}
