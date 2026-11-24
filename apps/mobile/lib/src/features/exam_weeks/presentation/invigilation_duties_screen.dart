import 'package:easy_localization/easy_localization.dart' hide TextDirection;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/kit/app_icon_list_tile.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_accent_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/exam_weeks_providers.dart';
import '../domain/exam_weeks.dart';
import 'exam_weeks_widgets.dart';

/// The signed-in teacher's invigilation duties: every room they watch in the school's published
/// exam periods, upcoming first, each with the exam, grade and sections, time and room. Times are
/// the school's (its timezone is named at the top).
class InvigilationDutiesScreen extends ConsumerWidget {
  const InvigilationDutiesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final duties = ref.watch(myInvigilationDutiesProvider);
    final today = ref.watch(examWeeksClockProvider)();
    return Scaffold(
      appBar: AppBar(title: Text('examWeeks.duties.title'.tr())),
      body: RefreshIndicator(
        onRefresh: () async => ref.invalidate(myInvigilationDutiesProvider),
        child: duties.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, stackTrace) => ExamWeeksMessage(
            icon: Icons.error_outline,
            message: 'examWeeks.duties.error'.tr(),
          ),
          data: (data) {
            if (data.duties.isEmpty) {
              return ExamWeeksMessage(
                icon: Icons.event_available_outlined,
                message: 'examWeeks.duties.empty'.tr(),
              );
            }
            final upcoming = [
              for (final duty in data.duties)
                if (!isPastDay(duty.date, today)) duty,
            ];
            final past = [
              for (final duty in data.duties)
                if (isPastDay(duty.date, today)) duty,
            ].reversed.toList();
            return ListView(
              padding: const EdgeInsets.all(
                AppSpacing.space16,
              ).withBottomInset(context),
              physics: const AlwaysScrollableScrollPhysics(),
              children: [
                SchoolTimeNote(timezone: data.timezone),
                const SizedBox(height: AppSpacing.space16),
                if (upcoming.isEmpty)
                  Text('examWeeks.duties.noneUpcoming'.tr())
                else
                  for (final duty in upcoming)
                    _DutyCard(duty: duty, past: false),
                if (past.isNotEmpty) ...[
                  const SizedBox(height: AppSpacing.space16),
                  Text(
                    'examWeeks.duties.past'.tr(),
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  const SizedBox(height: AppSpacing.space8),
                  for (final duty in past) _DutyCard(duty: duty, past: true),
                ],
              ],
            );
          },
        ),
      ),
    );
  }
}

class _DutyCard extends StatelessWidget {
  const _DutyCard({required this.duty, required this.past});

  final InvigilationDuty duty;
  final bool past;

  @override
  Widget build(BuildContext context) {
    final exam = [
      duty.gradeLevel,
      if (duty.sections.isNotEmpty) duty.sections.join(', '),
    ].where((part) => part.isNotEmpty).join(' · ');
    return Opacity(
      opacity: past ? 0.6 : 1,
      child: Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.space8),
        child: AppIconListCard(
          icon: Icons.visibility_outlined,
          accent: past ? AppAccent.slate : AppAccent.teal,
          title: '${duty.subject} · $exam',
          subtitle: [
            examDayAndTime(context, duty.date, duty.startsAt, duty.endsAt),
            'examWeeks.duties.room'.tr(
              namedArgs: {'room': roomLabel(duty.room)},
            ),
            duty.periodName,
          ].join('\n'),
          showChevron: false,
        ),
      ),
    );
  }
}

/// The teacher home's way into their invigilation duties: shown only while they have one coming
/// up, with the next one named; most schools never use exam weeks.
class InvigilationDutiesCard extends ConsumerWidget {
  const InvigilationDutiesCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final data = ref.watch(myInvigilationDutiesProvider).value;
    final today = ref.watch(examWeeksClockProvider)();
    final upcoming = [
      for (final duty in data?.duties ?? const <InvigilationDuty>[])
        if (!isPastDay(duty.date, today)) duty,
    ];
    if (upcoming.isEmpty) return const SizedBox.shrink();
    final next = upcoming.first;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.space16),
      child: AppIconListCard(
        icon: Icons.visibility_outlined,
        accent: AppAccent.teal,
        title: 'examWeeks.duties.title'.tr(),
        subtitle: 'examWeeks.duties.next'.tr(
          namedArgs: {
            'exam': next.subject,
            'when': examDayAndTime(
              context,
              next.date,
              next.startsAt,
              next.endsAt,
            ),
            'room': next.room.name,
          },
        ),
        badgeLabel: '${upcoming.length}',
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => const InvigilationDutiesScreen(),
          ),
        ),
      ),
    );
  }
}
