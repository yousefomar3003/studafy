import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/offline/staleness_banner.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/materials_providers.dart';
import '../material_viewer_screen.dart';
import 'material_list_tile.dart';

/// One class's materials: the class code as a header, then its materials newest-first (the
/// server's own ordering — `listMaterials`'s `ORDER BY created_at DESC` — carried straight
/// through), or an empty/error line in place of the list.
class ClassMaterialsSection extends ConsumerWidget {
  const ClassMaterialsSection({required this.classId, super.key});

  final String classId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final classCode = ref.watch(materialsClassCodeProvider(classId));
    final materialsAsync = ref.watch(materialsForClassProvider(classId));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(classCode.value ?? 'materials.unknownClass'.tr(), style: textTheme.titleMedium),
        const SizedBox(height: AppSpacing.space8),
        materialsAsync.when(
          loading: () => const Padding(
            padding: EdgeInsets.symmetric(vertical: AppSpacing.space16),
            child: Center(child: CircularProgressIndicator()),
          ),
          error: (error, stackTrace) => Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
            child: Text(
              'materials.error'.tr(),
              style: textTheme.bodySmall?.copyWith(color: colorScheme.error),
            ),
          ),
          data: (cached) {
            if (cached.data.isEmpty) {
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
                child: Text(
                  'materials.empty'.tr(),
                  style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
                ),
              );
            }
            return Column(
              children: [
                if (cached.isStale) ...[
                  StalenessBanner(fetchedAt: cached.fetchedAt),
                  const SizedBox(height: AppSpacing.space8),
                ],
                for (final material in cached.data)
                  MaterialListTile(
                    material: material,
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => MaterialViewerScreen(material: material),
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
      ],
    );
  }
}
