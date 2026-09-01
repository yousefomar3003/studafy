import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/widgets.dart';

import '../../../student/presentation/widgets/status_pill.dart';
import '../../domain/attendance_taking.dart';

/// A [StatusPill] for one [AttendanceMarkStatus], tone-matched to the student-side attendance
/// pills so "absent" reads as danger and "late" as warning in both roles.
class AttendanceStatusChip extends StatelessWidget {
  const AttendanceStatusChip({required this.status, super.key});

  final AttendanceMarkStatus status;

  @override
  Widget build(BuildContext context) {
    return StatusPill(label: labelKeyFor(status).tr(), tone: toneFor(status));
  }

  static String labelKeyFor(AttendanceMarkStatus status) => switch (status) {
    AttendanceMarkStatus.present => 'attendance.status.present',
    AttendanceMarkStatus.absent => 'attendance.status.absent',
    AttendanceMarkStatus.late => 'attendance.status.late',
    AttendanceMarkStatus.excused => 'attendance.status.excused',
  };

  static StatusPillTone toneFor(AttendanceMarkStatus status) => switch (status) {
    AttendanceMarkStatus.present => StatusPillTone.success,
    AttendanceMarkStatus.absent => StatusPillTone.danger,
    AttendanceMarkStatus.late => StatusPillTone.warning,
    AttendanceMarkStatus.excused => StatusPillTone.neutral,
  };
}
