import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/child_comparison_item.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/parent_providers.dart';
import '../../domain/attendance_alert.dart';

/// The screen-header analogue of the parent home's `ChildSwitcher` card: a bare horizontal chip
/// bar. Callers show it only when the parent has more than one linked child. Tapping a chip
/// updates [selectedChildControllerProvider], which re-scopes every child-scoped parent screen
/// (home, Children, Messages) and persists the pick to this device.
class ChildSwitcherBar extends ConsumerWidget {
  const ChildSwitcherBar({required this.children, required this.selectedId, super.key});

  final List<ChildComparisonItem> children;
  final String selectedId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.space16,
        vertical: AppSpacing.space8,
      ),
      child: Row(
        children: [
          for (final child in children)
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
                selected: child.studentId == selectedId,
                onSelected: (_) =>
                    ref.read(selectedChildControllerProvider.notifier).select(child.studentId),
              ),
            ),
        ],
      ),
    );
  }
}
