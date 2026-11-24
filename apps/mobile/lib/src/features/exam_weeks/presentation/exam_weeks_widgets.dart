import 'package:easy_localization/easy_localization.dart' hide TextDirection;
import 'package:flutter/material.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../domain/exam_weeks.dart';

/// "Room 12 · Block A, floor 2": a room with where it is, when the school recorded that.
String roomLabel(ExamRoom room) {
  final place = [
    if (room.building case final String building when building.isNotEmpty)
      building,
    if (room.floor case final String floor when floor.isNotEmpty)
      'examWeeks.floor'.tr(namedArgs: {'floor': floor}),
  ].join(', ');
  return place.isEmpty ? room.name : '${room.name} · $place';
}

/// "Sun 10 Jan · 09:00–11:00", in the app's language. The times stay the school's wall clock;
/// the dash-separated range is kept left-to-right so Arabic reads it the same way.
String examDayAndTime(
  BuildContext context,
  DateTime date,
  String startsAt,
  String endsAt,
) {
  final day = DateFormat.MMMEd(context.locale.toString()).format(date);
  return '$day · \u2066$startsAt–$endsAt\u2069';
}

/// "Times are school time (Asia/Amman)." Shown above an exam timetable or duty list; nothing from
/// an older server that does not send the timezone.
class SchoolTimeNote extends StatelessWidget {
  const SchoolTimeNote({required this.timezone, super.key});

  final String? timezone;

  @override
  Widget build(BuildContext context) {
    final zone = timezone;
    if (zone == null || zone.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Row(
      children: [
        Icon(
          Icons.schedule,
          size: 16,
          color: theme.colorScheme.onSurfaceVariant,
        ),
        const SizedBox(width: AppSpacing.space8),
        Expanded(
          child: Text(
            'examWeeks.schoolTime'.tr(namedArgs: {'timezone': zone}),
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
      ],
    );
  }
}

/// A full-screen message (loading failed, nothing to show) that still pulls to refresh.
class ExamWeeksMessage extends StatelessWidget {
  const ExamWeeksMessage({
    required this.icon,
    required this.message,
    super.key,
  });

  final IconData icon;
  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AppSpacing.space24),
      children: [
        const SizedBox(height: AppSpacing.space48),
        Icon(icon, size: 40, color: theme.colorScheme.onSurfaceVariant),
        const SizedBox(height: AppSpacing.space12),
        Text(
          message,
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium,
        ),
      ],
    );
  }
}
