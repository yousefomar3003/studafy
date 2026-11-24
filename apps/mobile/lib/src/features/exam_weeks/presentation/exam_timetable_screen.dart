import 'package:easy_localization/easy_localization.dart' hide TextDirection;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/kit/app_icon_list_tile.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_accent_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../student/application/student_context_providers.dart';
import '../application/exam_weeks_providers.dart';
import '../domain/exam_weeks.dart';
import 'exam_weeks_widgets.dart';

/// A student's exam timetable: every exam of the school's published exam periods they sit, by
/// day, with the room and seat number once the school has seated them. Dates and times are the
/// school's (its timezone is named at the top), never converted to the phone's.
///
/// Shared by both audiences, like `AcademicResultsScreen`: the student opens it with no
/// [studentId] (resolved from `currentStudentIdProvider`); a parent opens it for a linked child.
/// The API only serves a student their own timetable and a parent their children's.
class ExamTimetableScreen extends ConsumerWidget {
  const ExamTimetableScreen({this.studentId, this.studentName, super.key});

  /// Whose timetable to show. Null = the signed-in student.
  final String? studentId;

  /// Shown under the title (a parent's child name).
  final String? studentName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = studentId ?? ref.watch(currentStudentIdProvider);
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('examWeeks.timetable.title'.tr()),
            if (studentName != null)
              Text(studentName!, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
      body: id == null
          ? ExamWeeksMessage(
              icon: Icons.info_outline,
              message: 'examWeeks.timetable.unavailable'.tr(),
            )
          : _TimetableBody(studentId: id),
    );
  }
}

class _TimetableBody extends ConsumerWidget {
  const _TimetableBody({required this.studentId});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final timetable = ref.watch(studentExamTimetableProvider(studentId));
    final today = ref.watch(examWeeksClockProvider)();
    return RefreshIndicator(
      onRefresh: () async =>
          ref.invalidate(studentExamTimetableProvider(studentId)),
      child: timetable.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stackTrace) => ExamWeeksMessage(
          icon: Icons.error_outline,
          message: 'examWeeks.timetable.error'.tr(),
        ),
        data: (data) => data.isEmpty
            ? ExamWeeksMessage(
                icon: Icons.event_available_outlined,
                message: 'examWeeks.timetable.empty'.tr(),
              )
            : ListView(
                padding: const EdgeInsets.all(
                  AppSpacing.space16,
                ).withBottomInset(context),
                physics: const AlwaysScrollableScrollPhysics(),
                children: [
                  SchoolTimeNote(timezone: data.timezone),
                  for (final period in data.periods)
                    if (period.exams.isNotEmpty) ...[
                      const SizedBox(height: AppSpacing.space16),
                      _PeriodHeader(period: period),
                      const SizedBox(height: AppSpacing.space8),
                      for (final exam in period.exams)
                        _ExamCard(
                          exam: exam,
                          past: isPastDay(exam.date, today),
                        ),
                    ],
                ],
              ),
      ),
    );
  }
}

String examPeriodKindLabel(ExamPeriodKind kind) => switch (kind) {
  ExamPeriodKind.midterm => 'examWeeks.kinds.midterm'.tr(),
  ExamPeriodKind.finalExams => 'examWeeks.kinds.final'.tr(),
  ExamPeriodKind.monthly => 'examWeeks.kinds.monthly'.tr(),
  ExamPeriodKind.mock => 'examWeeks.kinds.mock'.tr(),
  ExamPeriodKind.other => 'examWeeks.kinds.other'.tr(),
  ExamPeriodKind.unknown => 'examWeeks.kinds.unknown'.tr(),
};

class _PeriodHeader extends StatelessWidget {
  const _PeriodHeader({required this.period});

  final StudentExamPeriod period;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final locale = context.locale.toString();
    final format = DateFormat.MMMd(locale);
    final dates = period.startsOn != null && period.endsOn != null
        ? '${format.format(period.startsOn!)} – ${format.format(period.endsOn!)}'
        : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(period.name, style: theme.textTheme.titleMedium),
        Text(
          [examPeriodKindLabel(period.kind), ?dates].join(' · '),
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

class _ExamCard extends StatelessWidget {
  const _ExamCard({required this.exam, required this.past});

  final StudentExam exam;
  final bool past;

  @override
  Widget build(BuildContext context) {
    final room = exam.room;
    final seat = exam.seatNumber;
    final where = room == null
        ? 'examWeeks.timetable.notSeated'.tr()
        : seat == null
        ? roomLabel(room)
        : 'examWeeks.timetable.roomAndSeat'.tr(
            namedArgs: {'room': roomLabel(room), 'seat': '$seat'},
          );
    return Opacity(
      opacity: past ? 0.6 : 1,
      child: Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.space8),
        child: AppIconListCard(
          key: ValueKey('exam-${exam.id}'),
          icon: Icons.event_seat_outlined,
          accent: past ? AppAccent.slate : AppAccent.blue,
          title: exam.subject,
          subtitle:
              '${examDayAndTime(context, exam.date, exam.startsAt, exam.endsAt)}\n$where',
          showChevron: false,
        ),
      ),
    );
  }
}

/// Opens the student's exam timetable from their grades. Shown only once the school has
/// published an exam period the student sits; most schools never use exam weeks.
class ExamTimetableButton extends ConsumerWidget {
  const ExamTimetableButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = ref.watch(currentStudentIdProvider);
    if (id == null) return const SizedBox.shrink();
    final timetable = ref.watch(studentExamTimetableProvider(id)).value;
    if (timetable == null || timetable.isEmpty) return const SizedBox.shrink();
    return IconButton(
      icon: const Icon(Icons.event_seat_outlined),
      tooltip: 'examWeeks.timetable.entry'.tr(),
      onPressed: () => Navigator.of(context).push(
        MaterialPageRoute<void>(builder: (_) => const ExamTimetableScreen()),
      ),
    );
  }
}

/// The parent's way into a child's exam timetable, beside the official results. Shown only once
/// the school has published an exam period the child sits.
class ExamTimetableTile extends ConsumerWidget {
  const ExamTimetableTile({
    required this.studentId,
    this.studentName,
    super.key,
  });

  final String studentId;
  final String? studentName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final timetable = ref.watch(studentExamTimetableProvider(studentId)).value;
    if (timetable == null || timetable.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space12),
      child: AppIconListCard(
        icon: Icons.event_seat_outlined,
        accent: AppAccent.blue,
        title: 'examWeeks.timetable.entry'.tr(),
        subtitle: 'examWeeks.timetable.entrySubtitle'.tr(),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => ExamTimetableScreen(
              studentId: studentId,
              studentName: studentName,
            ),
          ),
        ),
      ),
    );
  }
}
