import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../student/presentation/widgets/status_pill.dart';
import '../../domain/grade_entry.dart';

/// A [StatusPill] for one [GradeSubmissionStatus], with a fixed tone per state: a live draft is
/// neutral, "submitted" (awaiting approval) is a warning, "rejected" is a danger, and
/// approved/published read as success.
class GradeStatusChip extends StatelessWidget {
  const GradeStatusChip({required this.status, super.key});

  final GradeSubmissionStatus status;

  @override
  Widget build(BuildContext context) {
    return StatusPill(label: _labelKey(status).tr(), tone: _tone(status));
  }

  static String _labelKey(GradeSubmissionStatus status) => switch (status) {
        GradeSubmissionStatus.draft => 'teacher.grades.status.draft',
        GradeSubmissionStatus.submitted => 'teacher.grades.status.submitted',
        GradeSubmissionStatus.approved => 'teacher.grades.status.approved',
        GradeSubmissionStatus.rejected => 'teacher.grades.status.rejected',
        GradeSubmissionStatus.published => 'teacher.grades.status.published',
        GradeSubmissionStatus.unknown => 'teacher.grades.status.submitted',
      };

  static StatusPillTone _tone(GradeSubmissionStatus status) => switch (status) {
        GradeSubmissionStatus.draft => StatusPillTone.neutral,
        GradeSubmissionStatus.submitted => StatusPillTone.warning,
        GradeSubmissionStatus.approved => StatusPillTone.success,
        GradeSubmissionStatus.published => StatusPillTone.success,
        GradeSubmissionStatus.rejected => StatusPillTone.danger,
        GradeSubmissionStatus.unknown => StatusPillTone.warning,
      };
}
