import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/assignment_list_providers.dart';
import '../domain/assignment_list_filter.dart';
import 'assignment_detail_screen.dart';
import 'widgets/assignment_list_tile.dart';

/// The student's full assignment list: due, submitted, and graded tabs, each independently
/// loaded — see [studentAssignmentsProvider]'s doc comment for why a `graded` tab costs more
/// than a status query.
class StudentAssignmentsScreen extends StatelessWidget {
  const StudentAssignmentsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: AssignmentListFilter.values.length,
      child: Scaffold(
        appBar: AppBar(
          title: Text('assignments.list.title'.tr()),
          bottom: TabBar(
            tabs: [for (final filter in AssignmentListFilter.values) Tab(text: _tabLabel(filter))],
          ),
        ),
        body: TabBarView(
          children: [
            for (final filter in AssignmentListFilter.values) _AssignmentListTab(filter: filter),
          ],
        ),
      ),
    );
  }

  String _tabLabel(AssignmentListFilter filter) => switch (filter) {
    AssignmentListFilter.due => 'assignments.list.tabs.due'.tr(),
    AssignmentListFilter.submitted => 'assignments.list.tabs.submitted'.tr(),
    AssignmentListFilter.graded => 'assignments.list.tabs.graded'.tr(),
  };
}

class _AssignmentListTab extends ConsumerWidget {
  const _AssignmentListTab({required this.filter});

  final AssignmentListFilter filter;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final assignments = ref.watch(studentAssignmentsProvider(filter));

    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(studentAssignmentsProvider(filter)),
      child: assignments.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stackTrace) =>
            _ScrollableMessage(icon: Icons.error_outline, messageKey: 'assignments.list.error'),
        data: (pairs) {
          if (pairs.isEmpty) {
            return _ScrollableMessage(
              icon: Icons.check_circle_outline,
              messageKey: _emptyKeyFor(filter),
            );
          }
          return ListView.separated(
            physics: const AlwaysScrollableScrollPhysics(),
            itemCount: pairs.length,
            separatorBuilder: (context, index) => const Divider(height: 1),
            itemBuilder: (context, index) {
              final pair = pairs[index];
              return AssignmentListTile(
                pair: pair,
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => AssignmentDetailScreen(assignmentId: pair.assignment.id),
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }

  String _emptyKeyFor(AssignmentListFilter filter) => switch (filter) {
    AssignmentListFilter.due => 'assignments.list.empty.due',
    AssignmentListFilter.submitted => 'assignments.list.empty.submitted',
    AssignmentListFilter.graded => 'assignments.list.empty.graded',
  };
}

/// A centered icon+message filling the tab, wrapped in a scrollable so
/// [RefreshIndicator]'s pull-to-refresh keeps working on an empty or errored tab, not just a
/// populated one.
class _ScrollableMessage extends StatelessWidget {
  const _ScrollableMessage({required this.icon, required this.messageKey});

  final IconData icon;
  final String messageKey;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AppSpacing.space32),
      children: [
        Column(
          children: [
            Icon(icon, size: 32, color: colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space12),
            Text(
              messageKey.tr(),
              textAlign: TextAlign.center,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ],
    );
  }
}
