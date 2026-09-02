import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/child_comparison_item.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/parent_providers.dart';
import '../domain/attendance_alert.dart';
import 'widgets/child_assignments_view.dart';
import 'widgets/child_attendance_view.dart';
import 'widgets/child_detail_placeholders.dart';
import 'widgets/child_grades_view.dart';
import 'widgets/child_timetable_view.dart';

/// The parent shell's "Children" tab: one linked child's academic detail — grades, attendance,
/// timetable and assignment status — with a chip bar to move between children.
///
/// The active child is [selectedChildProvider] (this session's switcher pick, else the choice
/// persisted on this device, else the first linked child), shared with the parent home so the
/// two tabs stay on the same child. Every sub-view scopes to `child.studentId`; the breakdown
/// endpoint behind them is parent-only and RLS-scoped to `parent_child_links`, so a parent can
/// never load a child that is not theirs.
class ChildDetailScreen extends ConsumerWidget {
  const ChildDetailScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ref.watch(selectedChildProvider).when(
      loading: () => const ChildDetailSkeleton(),
      error: (_, _) => const ChildDetailMessage(
        messageKey: 'parent.children.error',
        icon: Icons.error_outline,
      ),
      data: (child) {
        if (child == null) {
          return const ChildDetailMessage(
            messageKey: 'parent.children.empty',
            icon: Icons.info_outline,
          );
        }
        return _ChildDetail(child: child);
      },
    );
  }
}

class _ChildDetail extends ConsumerWidget {
  const _ChildDetail({required this.child});

  final ChildComparisonItem child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final children = ref.watch(linkedChildrenProvider).value ?? const <ChildComparisonItem>[];

    return DefaultTabController(
      length: 4,
      child: Column(
        children: [
          if (children.length > 1)
            _ChildSwitcherBar(children: children, selectedId: child.studentId),
          Material(
            color: Theme.of(context).colorScheme.surface,
            child: TabBar(
              isScrollable: true,
              tabAlignment: TabAlignment.start,
              tabs: [
                Tab(text: 'parent.childDetail.tabs.grades'.tr()),
                Tab(text: 'parent.childDetail.tabs.attendance'.tr()),
                Tab(text: 'parent.childDetail.tabs.timetable'.tr()),
                Tab(text: 'parent.childDetail.tabs.assignments'.tr()),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              children: [
                ChildGradesView(studentId: child.studentId),
                ChildAttendanceView(studentId: child.studentId),
                const ChildTimetableView(),
                ChildAssignmentsView(studentId: child.studentId),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The screen-header analogue of the parent home's `ChildSwitcher` card: a bare horizontal chip
/// bar, shown only when the parent has more than one linked child. Tapping a chip updates
/// [selectedChildControllerProvider], which re-scopes this screen (and the home tab) and
/// persists the pick to this device.
class _ChildSwitcherBar extends ConsumerWidget {
  const _ChildSwitcherBar({required this.children, required this.selectedId});

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
                onSelected: (_) => ref
                    .read(selectedChildControllerProvider.notifier)
                    .select(child.studentId),
              ),
            ),
        ],
      ),
    );
  }
}
