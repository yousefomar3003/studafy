import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../student/application/materials_providers.dart';
import '../../../student/application/student_context_providers.dart';
import '../../../student/domain/material_ready_state.dart';
import '../../application/ask_ai_controller.dart';

/// Lets the student pick what to ask about: "All my materials" or one material. Lists the same
/// per-class materials as the quiz picker (`materialsForClassProvider`). Only materials Ask AI can
/// answer from (ready and included in the AI study assistant) can be picked; the rest are shown
/// greyed with the reason, so an empty-looking list never hides what the class has. Resolves to
/// the chosen material, [AskAiMaterialScope.all] for every material, or null when dismissed.
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
        const SizedBox(height: AppSpacing.space8),
        ListTile(
          key: const Key('askAiMaterialAll'),
          contentPadding: EdgeInsets.zero,
          leading: Icon(Icons.library_books_outlined, color: theme.colorScheme.primary),
          title: Text('askAi.material.all'.tr()),
          subtitle: Text('askAi.material.allHint'.tr()),
          trailing: current == null
              ? Icon(Icons.check_rounded, color: theme.colorScheme.primary)
              : null,
          onTap: () => Navigator.of(context).pop(AskAiMaterialScope.all),
        ),
        const Divider(height: 1),
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
        final materials = cached.data;
        if (materials.isEmpty) return const SizedBox.shrink();

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
            for (final material in materials)
              _MaterialTile(
                id: material.id,
                title: material.title,
                unavailableKey: _unavailableReason(
                  aiVisible: material.aiVisible,
                  state: materialReadyStateFromWireName(material.ingestStatus.name),
                ),
                selected: current?.id == material.id,
              ),
          ],
        );
      },
    );
  }
}

/// Why a material can't be asked about yet, as a translation key, or null when it can.
String? _unavailableReason({required bool aiVisible, required MaterialReadyState state}) {
  if (!aiVisible) return 'askAi.material.notShared';
  return switch (state) {
    MaterialReadyState.ready => null,
    MaterialReadyState.failed || MaterialReadyState.quarantined => 'askAi.material.unavailable',
    _ => 'askAi.material.preparing',
  };
}

class _MaterialTile extends StatelessWidget {
  const _MaterialTile({
    required this.id,
    required this.title,
    required this.unavailableKey,
    required this.selected,
  });

  final String id;
  final String title;
  final String? unavailableKey;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final reason = unavailableKey;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      enabled: reason == null,
      leading: Icon(
        Icons.description_outlined,
        color: reason == null ? theme.colorScheme.primary : theme.disabledColor,
      ),
      title: Text(title),
      subtitle: reason == null ? null : Text(reason.tr()),
      trailing: selected ? Icon(Icons.check_rounded, color: theme.colorScheme.primary) : null,
      onTap: reason == null
          ? () => Navigator.of(context).pop(AskAiMaterialScope(id: id, title: title))
          : null,
    );
  }
}
