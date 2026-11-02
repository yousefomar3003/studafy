import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/generated/models/attendance_record_status.dart';
import 'status_pill.dart';

/// A [StatusPill] for one [AttendanceRecordStatus], with a fixed [StatusPillTone] per state so
/// "excused", "late" and "absent" each read as visually distinct — excused stays neutral, late
/// is a warning, absent is a danger, and a plain (or remote) attendance is a success.
class AttendanceStatusPill extends StatelessWidget {
  const AttendanceStatusPill({required this.status, super.key});

  final AttendanceRecordStatus status;

  @override
  Widget build(BuildContext context) {
    return StatusPill(label: labelKeyFor(status).tr(), tone: toneFor(status));
  }

  /// Translation key for [status]. `$unknown` (a wire value newer than this build) falls back to
  /// the absent copy — it never reaches the UI through [assembleAttendanceHistory] today.
  static String labelKeyFor(AttendanceRecordStatus status) => switch (status) {
    AttendanceRecordStatus.present => 'attendance.status.present',
    AttendanceRecordStatus.absent => 'attendance.status.absent',
    AttendanceRecordStatus.valueLate => 'attendance.status.late',
    AttendanceRecordStatus.excused => 'attendance.status.excused',
    AttendanceRecordStatus.remote => 'attendance.status.remote',
    AttendanceRecordStatus.$unknown => 'attendance.status.absent',
  };

  static StatusPillTone toneFor(AttendanceRecordStatus status) => switch (status) {
    AttendanceRecordStatus.present => StatusPillTone.success,
    AttendanceRecordStatus.remote => StatusPillTone.success,
    AttendanceRecordStatus.valueLate => StatusPillTone.warning,
    AttendanceRecordStatus.excused => StatusPillTone.neutral,
    AttendanceRecordStatus.absent => StatusPillTone.danger,
    AttendanceRecordStatus.$unknown => StatusPillTone.neutral,
  };
}
