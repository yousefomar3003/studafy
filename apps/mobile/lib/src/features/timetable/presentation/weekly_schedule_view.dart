import 'package:easy_localization/easy_localization.dart' hide TextDirection;
import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show ProviderListenable;

import '../../../core/offline/staleness_banner.dart';
import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../shell/application/shell_providers.dart';
import '../application/weekly_schedule_providers.dart';
import '../domain/weekly_schedule.dart';
import 'widgets/lesson_card.dart';
import 'widgets/schedule_section.dart';
import 'widgets/timetable_placeholders.dart';
import '../../../design/layout/bottom_inset_padding.dart';

/// The clock a weekly schedule uses to pick the day it opens on. Override in tests.
final scheduleClockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// The shell destination whose (re)selection re-syncs the schedule — see [WeeklyScheduleTab].
const _timetableTabKey = 'shell.tabs.timetable';

/// A role's Timetable tab: loads [schedule] and renders it as a [WeeklyScheduleView].
///
/// The shell keeps a visited tab mounted, so this re-syncs (settings, approved version, slots)
/// every time the Timetable tab is selected again — an admin's re-approval shows up the next
/// time the tab is opened — as well as on pull-to-refresh.
class WeeklyScheduleTab extends ConsumerWidget {
  const WeeklyScheduleTab({
    required this.schedule,
    required this.audience,
    this.onSectionFilterChanged,
    super.key,
  });

  final ProviderListenable<AsyncValue<WeeklyScheduleStatus>> schedule;
  final ScheduleAudience audience;

  /// See [WeeklyScheduleView.onSectionFilterChanged].
  final ValueChanged<String?>? onSectionFilterChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(selectedShellTabProvider, (previous, next) {
      if (next == _timetableTabKey && previous != next) refreshWeeklySchedule(ref);
    });

    Future<void> onRefresh() => refreshWeeklySchedule(ref);

    final status = ref.watch(schedule);
    return status.when(
      loading: () => const TimetableSkeleton(),
      error: (error, stackTrace) => RefreshIndicator(
        onRefresh: onRefresh,
        child: const TimetableMessage(messageKey: 'timetable.error', icon: Icons.error_outline),
      ),
      data: (loaded) => switch (loaded) {
        WeeklyScheduleUnavailable() => RefreshIndicator(
          onRefresh: onRefresh,
          child: const TimetableMessage(
            messageKey: 'timetable.unavailable',
            icon: Icons.info_outline,
          ),
        ),
        WeeklyScheduleReady(value: final cached) when cached.data.isEmpty => RefreshIndicator(
          onRefresh: onRefresh,
          child: const TimetableMessage(
            messageKey: 'timetable.emptySchedule',
            icon: Icons.event_available_outlined,
          ),
        ),
        WeeklyScheduleReady(value: final cached) => Column(
          children: [
            if (cached.isStale) StalenessBanner(fetchedAt: cached.fetchedAt),
            Expanded(
              child: WeeklyScheduleView(
                schedule: cached.data,
                audience: audience,
                onRefresh: onRefresh,
                onSectionFilterChanged: onSectionFilterChanged,
              ),
            ),
          ],
        ),
      },
    );
  }
}

/// A fixed weekly class schedule: a row of day chips (the school's teaching days, in the school's
/// order) over the selected day's lessons. No dates — the schedule is the same every week.
/// Swiping the lesson list moves between days, following the reading direction.
///
/// A student's schedule is headed by its grade section ([WeeklySchedule.section]); a teacher's,
/// given [onSectionFilterChanged], offers a section filter once they teach two or more sections.
class WeeklyScheduleView extends ConsumerStatefulWidget {
  const WeeklyScheduleView({
    required this.schedule,
    required this.audience,
    required this.onRefresh,
    this.lessonLabels = const {},
    this.onSectionFilterChanged,
    super.key,
  });

  final WeeklySchedule schedule;
  final ScheduleAudience audience;
  final Future<void> Function() onRefresh;

  /// Pre-resolved labels by slot id, for a source that already carries every name (see
  /// [LessonCard.labels]). Slots without an entry resolve their own.
  final Map<String, LessonLabels> lessonLabels;

  /// Called with a section id (null for every section) when a section filter chip is picked.
  /// Null hides the filter — the schedule's source can't narrow by section.
  final ValueChanged<String?>? onSectionFilterChanged;

  @override
  ConsumerState<WeeklyScheduleView> createState() => _WeeklyScheduleViewState();
}

class _WeeklyScheduleViewState extends ConsumerState<WeeklyScheduleView> {
  late int _selectedDay;
  late PageController _pageController;
  final Map<int, GlobalKey> _chipKeys = {};

  List<int> get _days => widget.schedule.days;

  @override
  void initState() {
    super.initState();
    _selectedDay = initialScheduleDay(_days, ref.read(scheduleClockProvider)());
    _pageController = PageController(initialPage: _days.indexOf(_selectedDay));
  }

  @override
  void didUpdateWidget(WeeklyScheduleView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (listEquals(oldWidget.schedule.days, _days)) return;
    // A refresh changed the school week: keep the selected day if it survived, else re-pick.
    if (!_days.contains(_selectedDay)) {
      _selectedDay = initialScheduleDay(_days, ref.read(scheduleClockProvider)());
    }
    final page = _days.indexOf(_selectedDay);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _pageController.hasClients) _pageController.jumpToPage(page);
    });
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  void _selectDay(int weekday) {
    final page = _days.indexOf(weekday);
    if (page < 0) return;
    setState(() => _selectedDay = weekday);
    _pageController.animateToPage(
      page,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOutCubic,
    );
  }

  void _onPageChanged(int page) {
    setState(() => _selectedDay = _days[page]);
    final chipContext = _chipKeys[_selectedDay]?.currentContext;
    if (chipContext != null) {
      Scrollable.ensureVisible(
        chipContext,
        alignment: 0.5,
        duration: const Duration(milliseconds: 200),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final locale = context.locale.toString();
    final schedule = widget.schedule;
    final section = widget.audience == ScheduleAudience.student ? schedule.section : null;
    final onSectionFilterChanged = widget.onSectionFilterChanged;
    final showSectionFilter = onSectionFilterChanged != null && schedule.sections.length > 1;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.space16,
            AppSpacing.space16,
            AppSpacing.space16,
            AppSpacing.space12,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  Expanded(
                    child: Text(
                      'timetable.weeklySchedule'.tr(),
                      style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
                    ),
                  ),
                  Text(
                    'timetable.lessonsPerWeek'.plural(schedule.lessonCount),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
              if (section != null) ...[
                const SizedBox(height: AppSpacing.space4),
                ScheduleSectionHeader(section: section),
              ],
            ],
          ),
        ),
        if (showSectionFilter) ...[
          ScheduleSectionFilter(
            sections: schedule.sections,
            selected: schedule.sectionFilter,
            onSelected: onSectionFilterChanged,
          ),
          const SizedBox(height: AppSpacing.space8),
        ],
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space16),
          child: Row(
            children: [
              for (final (index, day) in _days.indexed) ...[
                if (index > 0) const SizedBox(width: AppSpacing.space8),
                _DayChip(
                  key: _chipKeys.putIfAbsent(day, GlobalKey.new),
                  label: shortWeekdayName(day, locale),
                  fullLabel: weekdayName(day, locale),
                  selected: day == _selectedDay,
                  onTap: () => _selectDay(day),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.space8),
        Expanded(
          child: PageView(
            controller: _pageController,
            onPageChanged: _onPageChanged,
            children: [
              for (final day in _days)
                _DayLessons(
                  dayName: weekdayName(day, locale),
                  lessons: [
                    for (final slot in schedule.slotsFor(day))
                      LessonCard(
                        slot: slot,
                        audience: widget.audience,
                        labels: widget.lessonLabels[slot.id],
                      ),
                  ],
                  onRefresh: widget.onRefresh,
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// A weekday's localized full name ("Monday" / "الاثنين"), 1 = Monday … 7 = Sunday. Formatted
/// from a fixed reference week (2024-01-01 was a Monday) — only the weekday is ever shown.
String weekdayName(int weekday, String locale) =>
    DateFormat.EEEE(locale).format(DateTime(2024, 1, weekday));

/// A weekday's localized short name ("Mon"; Arabic has no shorter form than the full name).
String shortWeekdayName(int weekday, String locale) =>
    DateFormat.E(locale).format(DateTime(2024, 1, weekday));

class _DayChip extends StatelessWidget {
  const _DayChip({
    required this.label,
    required this.fullLabel,
    required this.selected,
    required this.onTap,
    super.key,
  });

  final String label;
  final String fullLabel;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final shape = StadiumBorder(
      side: BorderSide(color: selected ? colorScheme.primaryContainer : colorScheme.outline),
    );

    return Semantics(
      button: true,
      selected: selected,
      label: fullLabel,
      excludeSemantics: true,
      child: Material(
        color: selected ? colorScheme.primaryContainer : colorScheme.surface,
        shape: shape,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 56, minHeight: 40),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.space16,
                vertical: AppSpacing.space8,
              ),
              child: Center(
                widthFactor: 1,
                child: Text(
                  label,
                  style: theme.textTheme.labelLarge?.copyWith(
                    color: selected ? colorScheme.onPrimaryContainer : colorScheme.onSurfaceVariant,
                    fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _DayLessons extends StatelessWidget {
  const _DayLessons({required this.dayName, required this.lessons, required this.onRefresh});

  final String dayName;
  final List<Widget> lessons;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.space16,
          AppSpacing.space8,
          AppSpacing.space16,
          AppSpacing.space24,
        ).withBottomInset(context),
        physics: const AlwaysScrollableScrollPhysics(),
        children: lessons.isEmpty
            ? [_FreeDay(dayName: dayName)]
            : [
                for (final (index, lesson) in lessons.indexed) ...[
                  if (index > 0) const SizedBox(height: AppSpacing.space12),
                  lesson,
                ],
              ],
      ),
    );
  }
}

class _FreeDay extends StatelessWidget {
  const _FreeDay({required this.dayName});

  final String dayName;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space48),
      child: Column(
        children: [
          DecoratedBox(
            decoration: BoxDecoration(
              color: colorScheme.primaryContainer,
              borderRadius: AppRadius.fullRadius,
            ),
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.space16),
              child: Icon(Icons.wb_sunny_outlined, size: 28, color: colorScheme.onPrimaryContainer),
            ),
          ),
          const SizedBox(height: AppSpacing.space16),
          Text(
            'timetable.freeDay'.tr(namedArgs: {'day': dayName}),
            textAlign: TextAlign.center,
            style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: AppSpacing.space4),
          Text(
            'timetable.freeDayHint'.tr(),
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}
