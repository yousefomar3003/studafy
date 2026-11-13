import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../student/application/materials_providers.dart';
import '../../../student/application/student_context_providers.dart';
import '../../../student/domain/material_ready_state.dart';

/// Picks up to [maxSelectable] ready-to-use materials to build an exam from — one
/// [CheckboxListTile] per material, grouped by enrolled class, the same source
/// (`materialsForClassProvider`) and ready-only filter `QuizMaterialPicker` uses.
///
/// Duplicated from `QuizMaterialPicker` rather than shared, the same call `QuizCitationChip`'s
/// doc comment makes for its own duplication: the selectable set is the same shape across every
/// AI feature's setup step, but each hardcodes its own feature's l10n keys (`examMode.setup.*`
/// vs `quiz.setup.*`), so sharing one widget would mean either a generic-but-wrong label or a
/// picker that reaches across features for its copy.
class ExamMaterialPicker extends ConsumerWidget {
  const ExamMaterialPicker({
    required this.selected,
    required this.onToggle,
    required this.maxSelectable,
    super.key,
  });

  final Set<String> selected;
  final ValueChanged<String> onToggle;
  final int maxSelectable;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final classIds = ref.watch(currentEnrolledClassIdsProvider);
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    if (classIds.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.space16),
        child: Text(
          'examMode.setup.materialsUnavailable'.tr(),
          style: TextStyle(color: colorScheme.onSurfaceVariant),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final classId in classIds) ...[
          _ClassMaterialOptions(
            classId: classId,
            selected: selected,
            onToggle: onToggle,
            atLimit: selected.length >= maxSelectable,
          ),
          const SizedBox(height: AppSpacing.space8),
        ],
        Text(
          'examMode.setup.materialCount'.tr(
            namedArgs: {'count': '${selected.length}', 'max': '$maxSelectable'},
          ),
          style: textTheme.labelMedium?.copyWith(color: colorScheme.onSurfaceVariant),
        ),
      ],
    );
  }
}

class _ClassMaterialOptions extends ConsumerWidget {
  const _ClassMaterialOptions({
    required this.classId,
    required this.selected,
    required this.onToggle,
    required this.atLimit,
  });

  final String classId;
  final Set<String> selected;
  final ValueChanged<String> onToggle;
  final bool atLimit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final classCode = ref.watch(materialsClassCodeProvider(classId));
    final materialsAsync = ref.watch(materialsForClassProvider(classId));
    final textTheme = Theme.of(context).textTheme;

    return materialsAsync.when(
      loading: () => const Padding(
        padding: EdgeInsets.symmetric(vertical: AppSpacing.space8),
        child: LinearProgressIndicator(),
      ),
      error: (error, stackTrace) => const SizedBox.shrink(),
      data: (cached) {
        final ready = cached.data
            .where(
              (material) =>
                  materialReadyStateFromWireName(material.ingestStatus.name) ==
                  MaterialReadyState.ready,
            )
            .toList();
        if (ready.isEmpty) return const SizedBox.shrink();

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
              child: Text(classCode.value ?? 'materials.unknownClass'.tr(), style: textTheme.titleSmall),
            ),
            for (final material in ready)
              CheckboxListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                title: Text(material.title),
                value: selected.contains(material.id),
                onChanged: atLimit && !selected.contains(material.id)
                    ? null
                    : (_) => onToggle(material.id),
              ),
          ],
        );
      },
    );
  }
}
