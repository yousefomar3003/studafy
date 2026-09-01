import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/enrollment.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/teacher_providers.dart';

/// One student in a class roster: their name (or a stable id fallback while the name-resolution
/// seam is empty — see [rosterStudentNameProvider]) and when they enrolled.
class RosterEntryTile extends ConsumerWidget {
  const RosterEntryTile({required this.enrollment, super.key});

  final Enrollment enrollment;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    final name = ref.watch(rosterStudentNameProvider(enrollment.studentId));
    final title = name ??
        'teacher.class.unknownStudent'.tr(namedArgs: {'id': _shortId(enrollment.studentId)});
    final enrolledOn = DateFormat.yMMMd(context.locale.toString()).format(enrollment.enrolledAt);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
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
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: textTheme.bodyMedium),
                Text(
                  'teacher.class.enrolledOn'.tr(namedArgs: {'date': enrolledOn}),
                  style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Last 6 characters of the UUID — enough to tell rows apart without showing the full id.
  String _shortId(String studentId) =>
      studentId.length <= 6 ? studentId : studentId.substring(studentId.length - 6);

  String _initial(String? name) {
    if (name == null || name.trim().isEmpty) return '#';
    return name.trim().characters.first.toUpperCase();
  }
}
