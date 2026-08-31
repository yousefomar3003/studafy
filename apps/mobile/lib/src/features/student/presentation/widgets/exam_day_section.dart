import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/upcoming_exams.dart';
import 'exam_card.dart';

/// One calendar day of the exams agenda: its date header, then that day's exams in start-time
/// order. The header mirrors `timetable_day_section.dart` so the two calendars read the same.
class ExamDaySection extends StatelessWidget {
  const ExamDaySection({required this.day, super.key});

  final ExamDay day;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final locale = context.locale.toString();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Text(DateFormat.EEEE(locale).format(day.date), style: theme.textTheme.titleMedium),
            const SizedBox(width: AppSpacing.space8),
            Text(
              DateFormat.MMMd(locale).format(day.date),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.space8),
        for (final exam in day.exams)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.space8),
            child: ExamCard(exam: exam),
          ),
      ],
    );
  }
}
