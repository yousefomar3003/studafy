import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/class.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../attendance_office/application/attendance_office_providers.dart';
import '../../../attendance_office/domain/attendance_office.dart';
import '../../../attendance_office/presentation/register_screen.dart';
import '../../../student/presentation/widgets/status_pill.dart';
import '../../application/teacher_providers.dart';

/// Opens today's register for one of the teacher's classes — the attendance office's
/// [RegisterScreen], read-only once submitted (teachers take registers but don't correct them) —
/// and refreshes the home's session states on the way back.
Future<void> openTeacherRegister(
  BuildContext context,
  WidgetRef ref, {
  required String classId,
  required String classCode,
}) async {
  await Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => RegisterScreen(
        classId: classId,
        classCode: classCode,
        date: dateOnly(DateTime.now()),
        canCorrect: false,
      ),
    ),
  );
  ref
    ..invalidate(teacherTodaySessionsProvider)
    ..invalidate(dailySessionsProvider(dateOnly(DateTime.now())));
}

/// The teacher home's primary action. With one class it goes straight to that class's register;
/// with several it asks which, listing today's timetabled classes first.
class TakeAttendanceButton extends ConsumerStatefulWidget {
  const TakeAttendanceButton({super.key});

  @override
  ConsumerState<TakeAttendanceButton> createState() =>
      _TakeAttendanceButtonState();
}

class _TakeAttendanceButtonState extends ConsumerState<TakeAttendanceButton> {
  bool _loading = false;

  Future<void> _start() async {
    setState(() => _loading = true);
    List<Class> classes;
    try {
      classes = await ref.read(teacherClassesProvider.future);
    } catch (_) {
      _snack('teacher.home.attendance.error'.tr());
      return;
    } finally {
      if (mounted) setState(() => _loading = false);
    }
    if (!mounted) return;

    if (classes.isEmpty) {
      _snack('teacher.home.attendance.noClasses'.tr());
      return;
    }
    final picked = classes.length == 1
        ? classes.single
        : await showModalBottomSheet<Class>(
            context: context,
            isScrollControlled: true,
            builder: (_) => _ClassPicker(classes: _todayFirst(classes)),
          );
    if (picked == null || !mounted) return;
    await openTeacherRegister(
      context,
      ref,
      classId: picked.id,
      classCode: picked.code,
    );
  }

  /// Classes on today's timetable in period order, then the rest by code.
  List<Class> _todayFirst(List<Class> classes) {
    final today = ref.read(teacherTodaySessionsProvider).value ?? const [];
    final firstPeriod = <String, int>{};
    for (final session in today) {
      firstPeriod.putIfAbsent(session.classId, () => session.period);
    }
    return [...classes]..sort((a, b) {
      final pa = firstPeriod[a.id];
      final pb = firstPeriod[b.id];
      if (pa != null && pb != null) return pa.compareTo(pb);
      if (pa != null) return -1;
      if (pb != null) return 1;
      return a.code.compareTo(b.code);
    });
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return FilledButton.icon(
      onPressed: _loading ? null : _start,
      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
      icon: _loading
          ? const SizedBox.square(
              dimension: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.fact_check_outlined),
      label: Text('teacher.home.attendance.take'.tr()),
    );
  }
}

/// Bottom sheet listing the teacher's classes with where today's register stands; pops the
/// chosen [Class].
class _ClassPicker extends ConsumerWidget {
  const _ClassPicker({required this.classes});

  final List<Class> classes;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final sessions = ref
        .watch(dailySessionsProvider(dateOnly(DateTime.now())))
        .value;

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.7,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.space16,
                0,
                AppSpacing.space16,
                AppSpacing.space8,
              ),
              child: Text(
                'teacher.home.attendance.pickClass'.tr(),
                style: textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: AppSpacing.space8),
                children: [
                  for (final classInfo in classes)
                    ListTile(
                      leading: const Icon(Icons.groups_outlined),
                      title: Text(classInfo.code),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (sessions != null)
                            _StatePill(
                              RegisterState.of(sessions[classInfo.id]),
                            ),
                          const SizedBox(width: AppSpacing.space4),
                          const Icon(Icons.chevron_right, size: 18),
                        ],
                      ),
                      onTap: () => Navigator.of(context).pop(classInfo),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatePill extends StatelessWidget {
  const _StatePill(this.state);

  final RegisterState state;

  @override
  Widget build(BuildContext context) {
    return StatusPill(
      label: 'attendanceOffice.state.${state.name}'.tr(),
      tone: switch (state) {
        RegisterState.notStarted => StatusPillTone.neutral,
        RegisterState.inProgress => StatusPillTone.warning,
        RegisterState.submitted => StatusPillTone.success,
      },
    );
  }
}
