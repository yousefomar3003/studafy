import '../../../core/api/generated/models/attendance_report_metrics.dart';

/// How a linked child's term attendance reads at a glance — the switcher badge and the
/// attendance card both derive from this.
///
/// It is a display heuristic over the term metrics the child-comparison report already
/// computes, not a verdict the server hands down. [chronicAbsenceThresholdPercent] is the one
/// tunable: missing 10% or more of recorded days is the line most systems label "chronic
/// absence", and it is where [needsAttention] begins. Below it, any absence at all is [watch];
/// a clean record — or a term with no attendance recorded yet — is [onTrack].
enum AttendanceAlert {
  onTrack,
  watch,
  needsAttention;

  /// Absent-day share, in percent, at or above which attendance reads as [needsAttention].
  static const int chronicAbsenceThresholdPercent = 10;

  static AttendanceAlert fromMetrics(AttendanceReportMetrics metrics) {
    if (metrics.totalRecords == 0 || metrics.absentCount == 0) {
      return AttendanceAlert.onTrack;
    }
    if (metrics.absentPercent >= chronicAbsenceThresholdPercent) {
      return AttendanceAlert.needsAttention;
    }
    return AttendanceAlert.watch;
  }

  /// True for anything the parent should notice — everything except [onTrack].
  bool get isElevated => this != AttendanceAlert.onTrack;
}
