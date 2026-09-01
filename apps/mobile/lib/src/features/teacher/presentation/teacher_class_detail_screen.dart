import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/teacher_providers.dart';
import 'widgets/roster_entry_tile.dart';

/// A class the signed-in teacher leads: its course, roster size, and the enrolled students.
///
/// Reached by pushing a route from the classes list or from a today's-session row, so it owns
/// its own [Scaffold]/[AppBar] (unlike the shell-tab screens). [classCode] is passed straight
/// through for the title so the header renders before the roster request resolves.
class TeacherClassDetailScreen extends ConsumerWidget {
  const TeacherClassDetailScreen({
    required this.classId,
    required this.classCode,
    super.key,
  });

  final String classId;
  final String classCode;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final roster = ref.watch(classRosterProvider(classId));
    final courseName = ref.watch(classCourseNameProvider(classId));

    return Scaffold(
      appBar: AppBar(title: Text(classCode)),
      body: RefreshIndicator(
        onRefresh: () async => ref.invalidate(classRosterProvider(classId)),
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.space16),
          children: [
            courseName.maybeWhen(
              data: (name) => Text(name, style: textTheme.titleMedium),
              orElse: () => const SizedBox.shrink(),
            ),
            const SizedBox(height: AppSpacing.space4),
            Text(
              'teacher.class.rosterTitle'.tr(),
              style: textTheme.titleSmall?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.space12),
            roster.when(
              loading: () => const Center(
                child: Padding(
                  padding: EdgeInsets.only(top: AppSpacing.space32),
                  child: CircularProgressIndicator(),
                ),
              ),
              error: (error, stackTrace) => const _Message(
                icon: Icons.error_outline,
                messageKey: 'teacher.class.rosterError',
              ),
              data: (enrollments) {
                if (enrollments.isEmpty) {
                  return const _Message(
                    icon: Icons.group_off_outlined,
                    messageKey: 'teacher.class.rosterEmpty',
                  );
                }
                return Column(
                  children: [
                    for (final enrollment in enrollments)
                      RosterEntryTile(enrollment: enrollment),
                  ],
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.messageKey});

  final IconData icon;
  final String messageKey;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space24),
      child: Row(
        children: [
          Icon(icon, size: 18, color: colorScheme.onSurfaceVariant),
          const SizedBox(width: AppSpacing.space8),
          Expanded(
            child: Text(
              messageKey.tr(),
              style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
          ),
        ],
      ),
    );
  }
}
