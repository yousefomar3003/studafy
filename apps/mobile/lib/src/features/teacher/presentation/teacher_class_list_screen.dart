import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/teacher_providers.dart';
import '../domain/teacher_class.dart';
import 'teacher_class_detail_screen.dart';

/// The teacher "Classes" tab: every class the signed-in teacher leads this term, each opening
/// its roster. Scoped to the teacher's own classes — the list request filters by
/// `lead_teacher_id`, and the API enforces the same limit.
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
        ),
        data: (list) {
          if (list.isEmpty) {
            return const _ScrollableMessage(
              icon: Icons.school_outlined,
              messageKey: 'teacher.classes.empty',
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.all(AppSpacing.space16),
            physics: const AlwaysScrollableScrollPhysics(),
            itemCount: list.length,
            separatorBuilder: (context, index) => const SizedBox(height: AppSpacing.space8),
            itemBuilder: (context, index) => _ClassTile(summary: list[index]),
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
          'teacher.classes.roster'.tr(namedArgs: {'count': '${summary.activeEnrollmentCount}'}),
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

class _ScrollableMessage extends StatelessWidget {
  const _ScrollableMessage({required this.icon, required this.messageKey});

  final IconData icon;
  final String messageKey;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

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
              style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ],
    );
  }
}
