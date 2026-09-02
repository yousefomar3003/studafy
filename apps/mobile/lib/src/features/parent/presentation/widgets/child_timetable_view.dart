import 'package:flutter/material.dart';

import 'child_detail_placeholders.dart';

/// The Timetable tab of `ChildDetailScreen`.
///
/// There is no parent-scoped source for a linked child's weekly schedule: no endpoint returns a
/// child's timetable to a parent, and none returns a child's active enrolments to resolve which
/// classes' slots to show. The child's *own* `TimetableScreen` is blocked by the same gap from
/// the other side — `currentEnrolledClassIdsProvider` (`student_context_providers.dart`) is an
/// unresolved seam, so that screen also renders "not available yet" today. This view therefore
/// has data parity with the child's own timetable view: both say the same thing until a
/// self-scoped enrolments endpoint (and a parent equivalent) ships, at which point this becomes
/// the student `TimetableScreen` scoped to the child, the same way the grades tab reuses
/// `SubjectGradesCard`.
class ChildTimetableView extends StatelessWidget {
  const ChildTimetableView({super.key});

  @override
  Widget build(BuildContext context) {
    return const ChildDetailMessage(
      messageKey: 'parent.childDetail.timetable.unavailable',
      hintKey: 'parent.childDetail.timetable.unavailableHint',
      icon: Icons.info_outline,
    );
  }
}
