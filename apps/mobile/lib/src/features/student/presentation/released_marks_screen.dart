import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../parent/application/parent_providers.dart';
import '../../shell/application/shell_providers.dart';
import '../../shell/domain/shell_role.dart';
import 'widgets/released_marks_widgets.dart';

/// A student's approved exam marks on their own page ([ReleasedMarksView]): each term on its own
/// (first semester, second semester, …), then the annual period for year-long assessments such
/// as the final exam, with a card per subject listing every released assessment by category.
///
/// A teacher's marks reach this screen only once school leadership approves them: the whole term's
/// mark sheet, or one assessment on its own (say, the first exam before the rest of the term); the
/// API returns nothing else. A subject released one assessment at a time says more marks are still
/// to come, and nothing here is ever a term total.
///
/// Opened by the `MARKS_RELEASED` notification (`/students/:studentId/marks`, for the student
/// themself or for a parent's child — the notification carries the student id, so a parent of
/// several children lands on the right one) and by a parent's "See all" on the child's Grades
/// tab. The student's own Grades screen shows the same view in its "Exam marks" tab.
class ReleasedMarksScreen extends ConsumerWidget {
  const ReleasedMarksScreen({this.studentId, this.studentName, super.key});

  /// Whose marks to show. Null = the signed-in student.
  final String? studentId;

  /// Shown under the title (a parent's child name). When a parent opens a child's marks without
  /// it (the notification's deep link), the name is looked up among their linked children.
  final String? studentName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = studentName ?? _linkedChildName(ref);

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('releasedMarks.title'.tr()),
            if (name != null)
              Text(name, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
      body: ReleasedMarksView(studentId: studentId),
    );
  }

  String? _linkedChildName(WidgetRef ref) {
    final id = studentId;
    if (id == null || ref.watch(shellRoleProvider) != ShellRole.parent) {
      return null;
    }
    final children = ref.watch(linkedChildrenProvider).value ?? const [];
    for (final child in children) {
      if (child.studentId == id) return child.studentName;
    }
    return null;
  }
}
