import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/timetable_providers.dart';

/// The week pager above the timetable: earlier/later by one week, the visible week's date range,
/// and a "this week" shortcut that only appears when the view has moved off the current week.
class TimetableWeekNavigator extends ConsumerWidget {
  const TimetableWeekNavigator({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final weekStart = ref.watch(visibleWeekProvider);
    final notifier = ref.read(visibleWeekProvider.notifier);

    // `MaterialLocalizations` (not `intl`'s `DateFormat`) on purpose: this widget is always
    // mounted in the student shell, including in shell tests that never call
    // `initializeDateFormatting`, whereas the Global*Localizations delegates
    // `context.localizationDelegates` already carries ship their own date symbols.
    final materialL10n = MaterialLocalizations.of(context);
    final weekEnd = weekStart.add(const Duration(days: 6));
    final rangeLabel =
        '${materialL10n.formatMediumDate(weekStart)} – ${materialL10n.formatMediumDate(weekEnd)}';
    final isCurrentWeek = weekStart == mondayOfWeek(DateTime.now());

    final isRtl = Directionality.of(context) == TextDirection.rtl;

    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: theme.colorScheme.outlineVariant)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space8,
          vertical: AppSpacing.space8,
        ),
        child: Row(
          children: [
            IconButton(
              icon: Icon(isRtl ? Icons.chevron_right : Icons.chevron_left),
              onPressed: notifier.previousWeek,
              tooltip: 'timetable.previousWeek'.tr(),
            ),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(rangeLabel, style: theme.textTheme.titleMedium),
                  if (!isCurrentWeek)
                    TextButton(
                      onPressed: notifier.thisWeek,
                      style: TextButton.styleFrom(
                        minimumSize: const Size(0, 0),
                        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space8),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                      child: Text('timetable.thisWeek'.tr()),
                    ),
                ],
              ),
            ),
            IconButton(
              icon: Icon(isRtl ? Icons.chevron_left : Icons.chevron_right),
              onPressed: notifier.nextWeek,
              tooltip: 'timetable.nextWeek'.tr(),
            ),
          ],
        ),
      ),
    );
  }
}
