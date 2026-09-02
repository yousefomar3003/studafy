import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/parent_providers.dart';
import '../../domain/attendance_alert.dart';
import 'parent_section_card.dart';

/// The child switcher: one selectable chip per linked child, horizontally scrollable. Tapping a
/// chip persists the choice (`SelectedChildController.select`) so it survives leaving and
/// re-opening the app. A child whose term attendance is elevated carries a small warning dot on
/// its chip.
///
/// Only children the child-comparison endpoint returns are shown, and that endpoint scopes to
/// the caller's `parent_child_links` rows — so the "only linked children appear" acceptance
/// criterion holds without any filtering here.
class ChildSwitcher extends ConsumerWidget {
  const ChildSwitcher({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final children = ref.watch(linkedChildrenProvider);
    final selected = ref.watch(selectedChildProvider).value;

    return ParentSectionCard(
      titleKey: 'parent.switcher.title',
      icon: Icons.family_restroom_outlined,
      child: children.when(
        loading: () => const ParentCardSkeleton(lineCount: 1),
        error: (_, _) => const ParentCardMessage(
          messageKey: 'parent.children.error',
          icon: Icons.error_outline,
        ),
        data: (list) {
          if (list.isEmpty) {
            return const ParentCardMessage(
              messageKey: 'parent.children.empty',
              icon: Icons.info_outline,
            );
          }
          return SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final child in list)
                  Padding(
                    padding: const EdgeInsetsDirectional.only(end: AppSpacing.space8),
                    child: ChoiceChip(
                      label: Text(child.studentName),
                      avatar: AttendanceAlert.fromMetrics(child.attendance).isElevated
                          ? Icon(
                              Icons.warning_amber_rounded,
                              size: 18,
                              color: Theme.of(context).colorScheme.error,
                            )
                          : null,
                      selected: child.studentId == selected?.studentId,
                      onSelected: (_) => ref
                          .read(selectedChildControllerProvider.notifier)
                          .select(child.studentId),
                    ),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}
