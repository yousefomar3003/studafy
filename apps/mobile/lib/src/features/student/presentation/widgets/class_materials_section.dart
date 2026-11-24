import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/offline/staleness_banner.dart';
import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/materials_providers.dart';
import '../material_viewer_screen.dart';
import 'material_list_tile.dart';
import 'material_week_sections.dart';

/// One class's materials: the class code as a header led by the class's subject badge
/// ([SubjectVisuals]), then its materials grouped into collapsible week sections with day
/// sub-groups ([MaterialWeekSections]), newest-first within a day (the server's own ordering —
/// `listMaterials`'s `ORDER BY created_at DESC` — carried straight through), or an empty/error
/// message in place of the list.
class ClassMaterialsSection extends ConsumerWidget {
  const ClassMaterialsSection({required this.classId, super.key});

  final String classId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final classCode = ref.watch(materialsClassCodeProvider(classId));
    final materialsAsync = ref.watch(materialsForClassProvider(classId));
    // In Arabic, the subject's Arabic name heads the section when the school has one.
    final subjectNameAr = context.locale.languageCode == 'ar'
        ? ref.watch(materialsClassSubjectNameArProvider(classId)).value
        : null;
    final visual = SubjectVisuals.of(classCode.value, fallbackKey: classId);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppSectionHeader(
          title:
              subjectNameAr ?? classCode.value ?? 'materials.unknownClass'.tr(),
          icon: visual.icon,
          accent: visual.accent,
        ),
        const SizedBox(height: AppSpacing.space12),
        materialsAsync.when(
          loading: () => const Padding(
            padding: EdgeInsets.symmetric(vertical: AppSpacing.space16),
            child: Center(child: CircularProgressIndicator()),
          ),
          error: (error, stackTrace) => _MessageCard(
            child: AppEmptyState(
              compact: true,
              icon: Icons.error_outline,
              accent: AppTone.danger.accent,
              message: 'materials.error'.tr(),
            ),
          ),
          data: (cached) {
            if (cached.data.isEmpty) {
              return _MessageCard(
                child: AppEmptyState(
                  compact: true,
                  icon: Icons.folder_open_outlined,
                  accent: visual.accent,
                  message: 'materials.empty'.tr(),
                ),
              );
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (cached.isStale) ...[
                  StalenessBanner(fetchedAt: cached.fetchedAt),
                  const SizedBox(height: AppSpacing.space8),
                ],
                MaterialWeekSections(
                  classId: classId,
                  materials: cached.data,
                  accent: visual.accent,
                  itemBuilder: (context, material) => MaterialListTile(
                    material: material,
                    accent: visual.accent,
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) =>
                            MaterialViewerScreen(material: material),
                      ),
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

/// A plain kit card around [child], for a class's one-line empty or error message.
class _MessageCard extends StatelessWidget {
  const _MessageCard({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => AppCardSurface(
    child: Padding(
      padding: const EdgeInsets.all(AppSpacing.space16),
      child: child,
    ),
  );
}
