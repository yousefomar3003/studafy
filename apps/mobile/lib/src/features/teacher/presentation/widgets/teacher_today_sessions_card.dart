import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/teacher_providers.dart';
import '../../domain/teacher_home.dart';
import 'take_attendance_button.dart';
import 'teacher_section_card.dart';

/// Today's teaching sessions for the signed-in teacher, nearest period first, each showing where
/// today's attendance stands. Tapping a session opens that class's register for today.
class TeacherTodaySessionsCard extends ConsumerWidget {
  const TeacherTodaySessionsCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessions = ref.watch(teacherTodaySessionsProvider);

    return TeacherSectionCard(
      titleKey: 'teacher.home.sessions.title',
      icon: Icons.schedule_outlined,
      child: sessions.when(
        loading: () => const TeacherCardSkeleton(),
        error: (error, stackTrace) => const TeacherCardMessage(
          messageKey: 'teacher.home.sessions.error',
          icon: Icons.error_outline,
        ),
        data: (list) {
          if (list.isEmpty) {
            return const TeacherCardMessage(
              messageKey: 'teacher.home.sessions.empty',
              icon: Icons.free_breakfast_outlined,
            );
          }
          return Column(
            children: [
              for (final session in list) _SessionRow(session: session),
            ],
          );
        },
      ),
    );
  }
}

class _SessionRow extends ConsumerWidget {
  const _SessionRow({required this.session});

  final TeacherSession session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return InkWell(
      onTap: () => openTeacherRegister(
        context,
        ref,
        classId: session.classId,
        classCode: session.classCode,
      ),
      borderRadius: BorderRadius.circular(AppSpacing.space8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(session.classCode, style: textTheme.bodyMedium),
                  Text(
                    'teacher.home.sessions.period'.tr(
                      namedArgs: {'period': '${session.period}'},
                    ),
                    style: textTheme.bodySmall?.copyWith(
                      color: colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.space12),
            _AttendanceStatus(session: session),
            const SizedBox(width: AppSpacing.space4),
            Icon(
              Icons.chevron_right,
              size: 18,
              color: colorScheme.onSurfaceVariant,
            ),
          ],
        ),
      ),
    );
  }
}

/// Where today's attendance for the session stands — not taken yet, in progress or recorded.
class _AttendanceStatus extends StatelessWidget {
  const _AttendanceStatus({required this.session});

  final TeacherSession session;

  @override
  Widget build(BuildContext context) {
    final labelKey = switch (session.attendance) {
      SessionAttendanceState.notStarted =>
        'teacher.home.sessions.attendanceNotTaken',
      SessionAttendanceState.inProgress =>
        'teacher.home.sessions.attendanceInProgress',
      SessionAttendanceState.recorded =>
        'teacher.home.sessions.attendanceRecorded',
    };

    return Chip(label: Text(labelKey.tr()));
  }
}
