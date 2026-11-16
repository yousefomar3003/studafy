import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/timetable_slot.dart';
import '../../../../core/auth/auth_providers.dart';
import '../../../../core/offline/staleness_banner.dart';
import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/today_providers.dart';
import '../../domain/today_section.dart';
import '../timetable_screen.dart';
import 'today_card_shell.dart';
import 'today_skeleton.dart';
import 'today_state_message.dart';

/// Resolves a class's display code by id, so [_SlotRow] can show "MATH101-A" instead of a raw
/// UUID. Riverpod's own `.family` cache is enough here — this is a handful of small, immutable
/// lookups per screen, not a fourth data source that needs [CachedValue]'s offline story.
final _classCodeProvider = FutureProvider.autoDispose.family<String, String>((
  ref,
  classId,
) async {
  final classValue = await ref
      .watch(apiClientProvider)
      .academics
      .getClass(classId: classId);
  return classValue.code;
});

/// Today's timetable, ordered by period.
class TodayTimetableCard extends ConsumerWidget {
  const TodayTimetableCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final section = ref.watch(todayTimetableProvider);

    return TodayCardShell(
      titleKey: 'today.timetable.title',
      icon: Icons.schedule_outlined,
      accent: AppAccent.blue,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          section.when(
            loading: () => const TodaySkeleton(),
            error: (error, stackTrace) => const TodayStateMessage(
              messageKey: 'today.timetable.error',
              icon: Icons.error_outline,
            ),
            data: (loaded) => switch (loaded) {
              TodaySectionUnavailable() => const TodayStateMessage(
                messageKey: 'today.timetable.unavailable',
                icon: Icons.info_outline,
              ),
              TodaySectionReady(value: final cached) when cached.data.isEmpty =>
                const TodayStateMessage(
                  messageKey: 'today.timetable.empty',
                  icon: Icons.weekend_outlined,
                ),
              TodaySectionReady(value: final cached) => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (cached.isStale) ...[
                    StalenessBanner(fetchedAt: cached.fetchedAt),
                    const SizedBox(height: AppSpacing.space12),
                  ],
                  for (final slot in cached.data) _SlotRow(slot: slot),
                ],
              ),
            },
          ),
          const _FullWeekButton(),
        ],
      ),
    );
  }
}

/// Opens the full weekly timetable, which the student shell no longer gives a tab of its own.
class _FullWeekButton extends StatelessWidget {
  const _FullWeekButton();

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: AlignmentDirectional.centerEnd,
      child: TextButton(
        onPressed: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => Scaffold(
              appBar: AppBar(title: Text('shell.tabs.timetable'.tr())),
              body: const TimetableScreen(),
            ),
          ),
        ),
        child: Text('today.timetable.viewWeek'.tr()),
      ),
    );
  }
}

class _SlotRow extends ConsumerWidget {
  const _SlotRow({required this.slot});

  final TimetableSlot slot;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colorScheme = Theme.of(context).colorScheme;
    final classCode = ref.watch(_classCodeProvider(slot.classId));
    // Coloured by subject once the class code is known; until then by the class id, which is
    // just as stable, so the row doesn't flash a different colour on every load.
    final visual = SubjectVisuals.of(classCode.value, fallbackKey: slot.classId);
    final period = 'timetable.period'.tr(namedArgs: {'period': '${slot.period}'});

    return classCode.when(
      loading: () => Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
        child: Row(
          children: [
            AppIconBadge(icon: visual.icon, accent: visual.accent),
            const SizedBox(width: AppSpacing.space12),
            DecoratedBox(
              decoration: BoxDecoration(
                color: colorScheme.surfaceContainerHighest,
                borderRadius: AppRadius.smRadius,
              ),
              child: const SizedBox(height: 14, width: 80),
            ),
          ],
        ),
      ),
      error: (error, stackTrace) => AppIconListTile(
        icon: visual.icon,
        accent: visual.accent,
        title: 'today.timetable.unknownClass'.tr(),
        subtitle: period,
      ),
      data: (code) => AppIconListTile(
        icon: visual.icon,
        accent: visual.accent,
        title: code,
        subtitle: period,
      ),
    );
  }
}
