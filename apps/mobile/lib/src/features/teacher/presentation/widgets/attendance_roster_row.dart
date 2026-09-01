import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/teacher_providers.dart';
import '../../domain/attendance_taking.dart';
import 'attendance_status_chip.dart';

/// One student in the take-attendance roster. The whole row is a tap target: a tap advances the
/// mark one step through the cycle (present → absent → late → excused → present). When the mark
/// is `late`, a compact stepper for the minutes-late value appears inline.
class AttendanceRosterRow extends ConsumerWidget {
  const AttendanceRosterRow({
    required this.studentId,
    required this.mark,
    required this.onCycle,
    required this.onMinutesLateChanged,
    super.key,
  });

  final String studentId;
  final AttendanceMark mark;
  final VoidCallback onCycle;
  final ValueChanged<int> onMinutesLateChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final name = ref.watch(rosterStudentNameProvider(studentId));
    final title =
        name ?? 'teacher.class.unknownStudent'.tr(namedArgs: {'id': _shortId(studentId)});

    return InkWell(
      onTap: onCycle,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          vertical: AppSpacing.space12,
          horizontal: AppSpacing.space4,
        ),
        child: Row(
          children: [
            CircleAvatar(
              radius: 16,
              backgroundColor: colorScheme.secondaryContainer,
              foregroundColor: colorScheme.onSecondaryContainer,
              child: Text(
                _initial(name),
                style: textTheme.labelLarge?.copyWith(color: colorScheme.onSecondaryContainer),
              ),
            ),
            const SizedBox(width: AppSpacing.space12),
            Expanded(
              child: Text(
                title,
                style: textTheme.bodyMedium,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            if (mark.status == AttendanceMarkStatus.late) ...[
              const SizedBox(width: AppSpacing.space8),
              _MinutesLateStepper(
                minutes: mark.minutesLate ?? kMinMinutesLate,
                onChanged: onMinutesLateChanged,
              ),
            ],
            const SizedBox(width: AppSpacing.space8),
            AttendanceStatusChip(status: mark.status),
          ],
        ),
      ),
    );
  }

  String _shortId(String id) => id.length <= 6 ? id : id.substring(id.length - 6);

  String _initial(String? name) {
    if (name == null || name.trim().isEmpty) return '#';
    return name.trim().characters.first.toUpperCase();
  }
}

/// `[–] N [+]` for the minutes-late value. Stays within `[kMinMinutesLate, 240]` — the API floor
/// is 1, and a lateness beyond a few hours is a different conversation than a register.
class _MinutesLateStepper extends StatelessWidget {
  const _MinutesLateStepper({required this.minutes, required this.onChanged});

  final int minutes;
  final ValueChanged<int> onChanged;

  static const int _max = 240;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _StepButton(
          icon: Icons.remove,
          onPressed: minutes > kMinMinutesLate ? () => onChanged(minutes - 1) : null,
          semanticLabel: 'teacher.attendance.minutesLateDecrease'.tr(),
        ),
        SizedBox(
          width: 28,
          child: Text(
            '$minutes',
            textAlign: TextAlign.center,
            style: textTheme.labelLarge,
          ),
        ),
        _StepButton(
          icon: Icons.add,
          onPressed: minutes < _max ? () => onChanged(minutes + 1) : null,
          semanticLabel: 'teacher.attendance.minutesLateIncrease'.tr(),
        ),
      ],
    );
  }
}

class _StepButton extends StatelessWidget {
  const _StepButton({required this.icon, required this.onPressed, required this.semanticLabel});

  final IconData icon;
  final VoidCallback? onPressed;
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: Icon(icon, size: 18),
      onPressed: onPressed,
      visualDensity: VisualDensity.compact,
      tooltip: semanticLabel,
      constraints: const BoxConstraints.tightFor(width: 32, height: 32),
      padding: EdgeInsets.zero,
    );
  }
}
