import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../student/application/materials_providers.dart';
import '../../../student/application/student_context_providers.dart';
import '../../../student/domain/material_ready_state.dart';
import '../../application/ask_ai_controller.dart';

/// Lets the student pick one material to ask about. Lists the same per-class materials as the
/// quiz picker (`materialsForClassProvider`), narrowed to those Ask AI can answer from: ready
/// and included in the AI assistant's study materials. Resolves to the chosen material, or null
/// when the sheet is dismissed.
Future<AskAiMaterialScope?> showAskAiMaterialSheet(
  BuildContext context, {
  AskAiMaterialScope? current,
}) {
  return showModalBottomSheet<AskAiMaterialScope>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.6,
      maxChildSize: 0.9,
      builder: (context, scrollController) =>
          _MaterialSheetBody(current: current, scrollController: scrollController),
    ),
  );
}

class _MaterialSheetBody extends ConsumerWidget {
  const _MaterialSheetBody({required this.current, required this.scrollController});

  final AskAiMaterialScope? current;
  final ScrollController scrollController;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final classIds = ref.watch(currentEnrolledClassIdsProvider);
    final theme = Theme.of(context);

    return ListView(
      controller: scrollController,
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.space16,
        0,
        AppSpacing.space16,
        AppSpacing.space24,
      ),
      children: [
        Text('askAi.material.sheetTitle'.tr(), style: theme.textTheme.titleMedium),
        const SizedBox(height: AppSpacing.space4),
        Text(
          'askAi.material.sheetHint'.tr(),
          style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: AppSpacing.space12),
        if (classIds.isEmpty)
          Text(
            'askAi.material.none'.tr(),
            style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
          )
        else
          for (final classId in classIds) _ClassMaterials(classId: classId, current: current),
      ],
    );
  }
}

class _ClassMaterials extends ConsumerWidget {
  const _ClassMaterials({required this.classId, required this.current});

  final String classId;
  final AskAiMaterialScope? current;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final classCode = ref.watch(materialsClassCodeProvider(classId));
    final materialsAsync = ref.watch(materialsForClassProvider(classId));
    final theme = Theme.of(context);

    return materialsAsync.when(
      loading: () => const Padding(
        padding: EdgeInsets.symmetric(vertical: AppSpacing.space8),
        child: LinearProgressIndicator(),
      ),
      error: (error, stackTrace) => const SizedBox.shrink(),
      data: (cached) {
        final askable = cached.data
            .where(
              (material) =>
                  material.aiVisible &&
                  materialReadyStateFromWireName(material.ingestStatus.name) ==
                      MaterialReadyState.ready,
            )
            .toList();
        if (askable.isEmpty) return const SizedBox.shrink();

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.space12, bottom: AppSpacing.space4),
              child: Text(
                classCode.value ?? 'materials.unknownClass'.tr(),
                style: theme.textTheme.labelLarge?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
            for (final material in askable)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(Icons.description_outlined, color: theme.colorScheme.primary),
                title: Text(material.title),
                trailing: current?.id == material.id
                    ? Icon(Icons.check_rounded, color: theme.colorScheme.primary)
                    : null,
                onTap: () => Navigator.of(
                  context,
                ).pop(AskAiMaterialScope(id: material.id, title: material.title)),
              ),
          ],
        );
      },
    );
  }
}
