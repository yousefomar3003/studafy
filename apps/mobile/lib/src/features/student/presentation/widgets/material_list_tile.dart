import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/material.dart';
import '../../../../design/kit/kit.dart';
import '../../application/materials_providers.dart';
import '../../domain/material_ready_state.dart';
import 'file_size.dart';
import 'material_ready_state_pill.dart';
import 'material_type_icon.dart';

/// One row on the class materials list: the file-type icon in a badge tinted with the class's
/// subject [accent], title, size, and — only when it isn't the unremarkable default case — a
/// [MaterialReadyStatePill] under the title. Untappable until the material is
/// [MaterialReadyState.ready].
///
/// Shows a small downloaded/not-downloaded indicator for PDFs and images specifically — the two
/// kinds the viewer screen caches on-device for offline use (`ensureMaterialDownloadedProvider`).
/// Other kinds are always handed off to another app over the network, the same as an assignment
/// attachment, so there is no on-device state to reflect for them.
class MaterialListTile extends ConsumerWidget {
  const MaterialListTile({
    required this.material,
    required this.onTap,
    this.accent = AppAccent.slate,
    super.key,
  });

  final Material material;
  final VoidCallback onTap;

  /// The class's subject accent ([SubjectVisuals]), which tints the file-type badge.
  final AppAccent accent;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colorScheme = Theme.of(context).colorScheme;
    final state = materialReadyStateFromWireName(material.ingestStatus.name);
    final kind = materialFileKindFor(material.mimeType);
    final offlineCapable = kind == MaterialFileKind.pdf || kind == MaterialFileKind.image;
    final downloaded =
        offlineCapable && (ref.watch(materialDownloadedProvider(material.id)).value ?? false);

    return AppIconListTile(
      onTap: state.isOpenable ? onTap : null,
      showChevron: false,
      icon: materialTypeIconFor(material.mimeType),
      accent: accent,
      title: material.title,
      subtitle: formatFileSize(material.sizeBytes),
      trailing: offlineCapable
          ? Icon(
              downloaded ? Icons.check_circle_outline : Icons.download_outlined,
              size: 18,
              color: downloaded ? colorScheme.primary : colorScheme.onSurfaceVariant,
            )
          : null,
      footer: state == MaterialReadyState.ready ? null : MaterialReadyStatePill(state: state),
    );
  }
}
