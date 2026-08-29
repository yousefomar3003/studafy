import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/material.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/materials_providers.dart';
import '../../domain/material_ready_state.dart';
import 'file_size.dart';
import 'material_ready_state_pill.dart';
import 'material_type_icon.dart';

/// One row on the class materials list: type icon, title, size, and — only when it isn't the
/// unremarkable default case — a [MaterialReadyStatePill]. Untappable until the material is
/// [MaterialReadyState.ready].
///
/// Shows a small downloaded/not-downloaded indicator for PDFs and images specifically — the two
/// kinds the viewer screen caches on-device for offline use (`ensureMaterialDownloadedProvider`).
/// Other kinds are always handed off to another app over the network, the same as an assignment
/// attachment, so there is no on-device state to reflect for them.
class MaterialListTile extends ConsumerWidget {
  const MaterialListTile({required this.material, required this.onTap, super.key});

  final Material material;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final state = materialReadyStateFromWireName(material.ingestStatus.name);
    final kind = materialFileKindFor(material.mimeType);
    final offlineCapable = kind == MaterialFileKind.pdf || kind == MaterialFileKind.image;
    final downloaded =
        offlineCapable && (ref.watch(materialDownloadedProvider(material.id)).valueOrNull ?? false);

    return ListTile(
      onTap: state.isOpenable ? onTap : null,
      enabled: state.isOpenable,
      contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.space16),
      leading: Icon(materialTypeIconFor(material.mimeType), color: colorScheme.onSurfaceVariant),
      title: Text(material.title, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(
        formatFileSize(material.sizeBytes),
        style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (offlineCapable)
            Icon(
              downloaded ? Icons.check_circle_outline : Icons.download_outlined,
              size: 18,
              color: downloaded ? colorScheme.primary : colorScheme.onSurfaceVariant,
            ),
          if (state != MaterialReadyState.ready) ...[
            const SizedBox(width: AppSpacing.space8),
            MaterialReadyStatePill(state: state),
          ],
        ],
      ),
    );
  }
}
