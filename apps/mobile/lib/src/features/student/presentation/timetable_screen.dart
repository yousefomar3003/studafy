import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/offline/staleness_banner.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/timetable_providers.dart';
import '../domain/timetable_week.dart';
import 'widgets/timetable_day_section.dart';
import 'widgets/timetable_placeholders.dart';
import 'widgets/timetable_week_navigator.dart';

/// The student's week view of the approved timetable: period, class, room and (when resolvable)
/// teacher per day, with exams for the shown week overlaid onto their day. Served from the offline
/// cache first (see [timetableWeekProvider]) so a week already viewed still shows with no
/// connectivity, marked stale.
class TimetableScreen extends ConsumerWidget {
  const TimetableScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(timetableWeekProvider);

    return Column(
      children: [
        const TimetableWeekNavigator(),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () async {
              ref
                ..invalidate(approvedTimetableVersionProvider)
                ..invalidate(timetableSlotsProvider)
                ..invalidate(weekExamsProvider);
            },
            child: status.when(
              loading: () => const TimetableSkeleton(),
              error: (error, stackTrace) => const TimetableMessage(
                messageKey: 'timetable.error',
                icon: Icons.error_outline,
              ),
              data: (weekStatus) => switch (weekStatus) {
                TimetableWeekUnavailable() => const TimetableMessage(
                  messageKey: 'timetable.unavailable',
                  icon: Icons.info_outline,
                ),
                TimetableWeekReady(value: final cached) when cached.data.isEmpty =>
                  const TimetableMessage(
                    messageKey: 'timetable.emptyWeek',
                    icon: Icons.event_available_outlined,
                  ),
                TimetableWeekReady(value: final cached) => ListView(
                  padding: const EdgeInsets.all(AppSpacing.space16),
                  physics: const AlwaysScrollableScrollPhysics(),
                  children: [
                    if (cached.isStale) ...[
                      StalenessBanner(fetchedAt: cached.fetchedAt),
                      const SizedBox(height: AppSpacing.space16),
                    ],
                    for (final day in cached.data.days) ...[
                      TimetableDaySection(day: day),
                      const SizedBox(height: AppSpacing.space24),
                    ],
                  ],
                ),
              },
            ),
          ),
        ),
      ],
    );
  }
}
