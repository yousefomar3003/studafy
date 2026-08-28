import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/timetable_slot.dart';
import '../../../../core/auth/auth_providers.dart';
import '../../../../core/offline/staleness_banner.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/today_providers.dart';
import '../../domain/today_section.dart';
import 'today_card_shell.dart';
import 'today_skeleton.dart';
import 'today_state_message.dart';

/// Resolves a class's display code by id, so [_SlotRow] can show "MATH101-A" instead of a raw
/// UUID. Riverpod's own `.family` cache is enough here — this is a handful of small, immutable
/// lookups per screen, not a fourth data source that needs [CachedValue]'s offline story.
final _classCodeProvider = FutureProvider.autoDispose.family<String, String>((ref, classId) async {
  final classValue = await ref.watch(apiClientProvider).academics.getClass(classId: classId);
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
      child: section.when(
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
    );
  }
}

class _SlotRow extends ConsumerWidget {
  const _SlotRow({required this.slot});

  final TimetableSlot slot;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final classCode = ref.watch(_classCodeProvider(slot.classId));

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Row(
        children: [
          SizedBox(
            width: 28,
            child: Text(
              '${slot.period}',
              style: textTheme.bodyMedium?.copyWith(
                color: colorScheme.primary,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.space8),
          Expanded(
            child: classCode.when(
              loading: () => DecoratedBox(
                decoration: BoxDecoration(
                  color: colorScheme.surfaceContainerHighest,
                  borderRadius: AppRadius.smRadius,
                ),
                child: const SizedBox(height: 14, width: 80),
              ),
              error: (error, stackTrace) => Text('today.timetable.unknownClass'.tr()),
              data: (code) => Text(code, style: textTheme.bodyMedium),
            ),
          ),
        ],
      ),
    );
  }
}
