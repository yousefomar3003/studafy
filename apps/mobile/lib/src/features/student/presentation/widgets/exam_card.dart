import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/exam.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/exams_providers.dart';
import '../../application/materials_providers.dart';
import '../materials_screen.dart';

/// A single exam in the agenda: its title and time, then its scope (class), room and gradebook
/// weight on one meta line, then a link into that class's study materials — the task's "linked
/// study materials", which opens [MaterialsScreen] narrowed to this exam's class.
///
/// The class code is resolved through `materialsClassCodeProvider` (shared with the materials
/// screen); an unresolved code falls back to the same generic "Class" label the timetable uses,
/// and an unresolved room simply omits the room segment.
class ExamCard extends ConsumerWidget {
  const ExamCard({required this.exam, super.key});

  final Exam exam;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final locale = context.locale.toString();

    final classCode = ref.watch(materialsClassCodeProvider(exam.classId)).value;
    final roomId = exam.roomId;
    final roomCode = roomId == null
        ? null
        : ref.watch(examRoomDirectoryProvider).value?[roomId];

    final startsAt = exam.startsAt.toLocal();
    final endsAt = exam.endsAt.toLocal();
    final meta = [
      'exams.scope'.tr(
        namedArgs: {'class': classCode ?? 'timetable.slot.unknownClass'.tr()},
      ),
      if (roomCode != null) 'exams.room'.tr(namedArgs: {'room': roomCode}),
      'exams.weight'.tr(namedArgs: {'weight': _formatWeight(exam.weight)}),
    ].join('  ·  ');

    final description = exam.description?.trim();

    return DecoratedBox(
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: AppRadius.mdRadius,
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.fact_check_outlined, size: 18, color: theme.colorScheme.primary),
                const SizedBox(width: AppSpacing.space8),
                Expanded(
                  child: Text(
                    exam.title,
                    style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                  ),
                ),
                const SizedBox(width: AppSpacing.space8),
                Text(
                  '${DateFormat.jm(locale).format(startsAt)} – '
                  '${DateFormat.jm(locale).format(endsAt)}',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space4),
            Text(
              meta,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            if (description != null && description.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.space4),
              Text(description, style: theme.textTheme.bodySmall),
            ],
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: TextButton.icon(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => MaterialsScreen(focusClassId: exam.classId),
                  ),
                ),
                icon: const Icon(Icons.menu_book_outlined, size: 18),
                label: Text('exams.studyMaterials'.tr()),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Trims a whole-number weight to an integer ("20" not "20.0"), leaving genuine fractions as
  /// they are.
  String _formatWeight(num weight) {
    return weight == weight.roundToDouble()
        ? weight.toInt().toString()
        : weight.toString();
  }
}
