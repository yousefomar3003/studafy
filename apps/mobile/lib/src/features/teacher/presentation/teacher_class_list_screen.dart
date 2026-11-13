import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/teacher_providers.dart';
import '../domain/teacher_class.dart';
import 'grading_assignments_screen.dart';
import 'teacher_class_detail_screen.dart';
import '../../../design/layout/bottom_inset_padding.dart';

/// The teacher "Classes" tab: every class the signed-in teacher leads this term, each opening
/// its roster. Scoped to the teacher's own classes — the list request filters by
/// `lead_teacher_id`, and the API enforces the same limit.
///
/// Led by the "Marks" entry ([GradingAssignmentsScreen]): academic marks are recorded per section
/// and subject rather than per class, so they get one entry point here instead of a per-class
/// action, shown whatever state the class list is in.
class TeacherClassListScreen extends ConsumerWidget {
  const TeacherClassListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final classes = ref.watch(teacherClassSummariesProvider);

    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(teacherClassesProvider),
      child: classes.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stackTrace) => const _ScrollableMessage(
          icon: Icons.error_outline,
          messageKey: 'teacher.classes.error',
          header: MarksEntryTile(),
        ),
        data: (list) {
          if (list.isEmpty) {
            return const _ScrollableMessage(
              icon: Icons.school_outlined,
              messageKey: 'teacher.classes.empty',
              header: MarksEntryTile(),
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.all(
              AppSpacing.space16,
            ).withBottomInset(context),
            physics: const AlwaysScrollableScrollPhysics(),
            itemCount: list.length + 1,
            separatorBuilder: (context, index) =>
                const SizedBox(height: AppSpacing.space8),
            itemBuilder: (context, index) => index == 0
                ? const MarksEntryTile()
                : _ClassTile(summary: list[index - 1]),
          );
        },
      ),
    );
  }
}

class _ClassTile extends StatelessWidget {
  const _ClassTile({required this.summary});

  final TeacherClass summary;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: EdgeInsets.zero,
      child: ListTile(
        title: Text(summary.code),
        subtitle: Text(summary.course.name),
        trailing: Text(
          'teacher.classes.roster'.tr(
            namedArgs: {'count': '${summary.activeEnrollmentCount}'},
          ),
          style: Theme.of(context).textTheme.bodySmall,
        ),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => TeacherClassDetailScreen(
              classId: summary.id,
              classCode: summary.code,
            ),
          ),
        ),
      ),
    );
  }
}

/// Opens the teacher's academic mark sheets ([GradingAssignmentsScreen]).
class MarksEntryTile extends StatelessWidget {
  const MarksEntryTile({super.key});

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      color: colorScheme.secondaryContainer,
      child: ListTile(
        leading: Icon(
          Icons.fact_check_outlined,
          color: colorScheme.onSecondaryContainer,
        ),
        title: Text('teacher.marks.open'.tr()),
        subtitle: Text('teacher.marks.openSubtitle'.tr()),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => const GradingAssignmentsScreen(),
          ),
        ),
      ),
    );
  }
}

class _ScrollableMessage extends StatelessWidget {
  const _ScrollableMessage({
    required this.icon,
    required this.messageKey,
    this.header,
  });

  final IconData icon;
  final String messageKey;

  /// Shown above the message (the Marks entry, which doesn't depend on the class list).
  final Widget? header;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(
        AppSpacing.space32,
      ).withBottomInset(context),
      children: [
        if (header != null) ...[
          header!,
          const SizedBox(height: AppSpacing.space24),
        ],
        Column(
          children: [
            Icon(icon, size: 32, color: colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space12),
            Text(
              messageKey.tr(),
              textAlign: TextAlign.center,
              style: textTheme.bodyMedium?.copyWith(
                color: colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ],
    );
  }
}
