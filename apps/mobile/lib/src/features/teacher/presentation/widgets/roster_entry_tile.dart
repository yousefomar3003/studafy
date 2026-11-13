import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/enrollment.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../custom_lists/application/custom_lists_providers.dart';
import '../../../shell/application/shell_providers.dart';
import '../../application/teacher_providers.dart';
import '../teacher_student_screen.dart';

/// One student in a class roster: their name (or a stable id fallback while the name-resolution
/// seam is empty — see [rosterStudentNameProvider]) and when they enrolled. Tapping opens the
/// teacher's page for the student in this class ([TeacherStudentScreen]): marks, attendance,
/// homework, comments, parents and the school's teacher-visible record fields (and from there the
/// school's custom lists about the student). Members without a staff role get a plain row.
class RosterEntryTile extends ConsumerWidget {
  const RosterEntryTile({required this.enrollment, super.key});

  final Enrollment enrollment;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    final name = ref.watch(rosterStudentNameProvider(enrollment.studentId));
    final title =
        name ??
        'teacher.class.unknownStudent'.tr(
          namedArgs: {'id': _shortId(enrollment.studentId)},
        );
    final enrolledOn = DateFormat.yMMMd(
      context.locale.toString(),
    ).format(enrollment.enrolledAt);

    final tile = Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
      child: Row(
        children: [
          CircleAvatar(
            radius: 16,
            backgroundColor: colorScheme.secondaryContainer,
            foregroundColor: colorScheme.onSecondaryContainer,
            child: Text(
              _initial(name),
              style: textTheme.labelLarge?.copyWith(
                color: colorScheme.onSecondaryContainer,
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.space12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: textTheme.bodyMedium),
                Text(
                  'teacher.class.enrolledOn'.tr(
                    namedArgs: {'date': enrolledOn},
                  ),
                  style: textTheme.bodySmall?.copyWith(
                    color: colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
    // Staff only, as before: the page and the API behind it are for the class's teachers.
    if (!canUseCustomLists(ref.watch(sessionRolesProvider))) return tile;
    return InkWell(
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => TeacherStudentScreen(
            classId: enrollment.classId,
            studentId: enrollment.studentId,
            studentName: title,
          ),
        ),
      ),
      child: Row(
        children: [
          Expanded(child: tile),
          Icon(Icons.chevron_right, color: colorScheme.onSurfaceVariant),
        ],
      ),
    );
  }

  /// Last 6 characters of the UUID — enough to tell rows apart without showing the full id.
  String _shortId(String studentId) => studentId.length <= 6
      ? studentId
      : studentId.substring(studentId.length - 6);

  String _initial(String? name) {
    if (name == null || name.trim().isEmpty) return '#';
    return name.trim().characters.first.toUpperCase();
  }
}
