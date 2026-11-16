import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/kit/kit.dart';
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
      accent: AppAccent.blue,
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
    final visual = SubjectVisuals.of(
      session.classCode,
      fallbackKey: session.classId,
    );

    return AppIconListTile(
      icon: visual.icon,
      accent: visual.accent,
      title: session.classCode,
      subtitle: 'teacher.home.sessions.period'.tr(
        namedArgs: {'period': '${session.period}'},
      ),
      // Under the period rather than beside the code: "Attendance in progress" is too wide to
      // share the line without cutting the class code short.
      footer: _AttendanceStatus(session: session),
      onTap: () => openTeacherRegister(
        context,
        ref,
        classId: session.classId,
        classCode: session.classCode,
      ),
    );
  }
}

/// Where today's attendance for the session stands — not taken yet (amber), in progress (blue)
/// or recorded (green).
class _AttendanceStatus extends StatelessWidget {
  const _AttendanceStatus({required this.session});

  final TeacherSession session;

  @override
  Widget build(BuildContext context) {
    final (labelKey, tone, icon) = switch (session.attendance) {
      SessionAttendanceState.notStarted => (
        'teacher.home.sessions.attendanceNotTaken',
        AppTone.warning,
        Icons.schedule,
      ),
      SessionAttendanceState.inProgress => (
        'teacher.home.sessions.attendanceInProgress',
        AppTone.brand,
        Icons.timelapse,
      ),
      SessionAttendanceState.recorded => (
        'teacher.home.sessions.attendanceRecorded',
        AppTone.success,
        Icons.check_circle_outline,
      ),
    };

    return AppStatusPill(label: labelKey.tr(), tone: tone, icon: icon);
  }
}
