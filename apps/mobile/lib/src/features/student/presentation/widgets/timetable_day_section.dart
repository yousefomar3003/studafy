import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/exam.dart';
import '../../../../core/api/generated/models/timetable_slot.dart';
import '../../../../core/auth/auth_providers.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/timetable_providers.dart';
import '../../domain/timetable_week.dart';

/// Resolves a class's display code by id ("MATH101-A" rather than a UUID). Riverpod's `.family`
/// cache covers the handful of distinct classes on one screen — same call the today screen's
/// timetable card makes.
final _classCodeProvider = FutureProvider.autoDispose.family<String, String>((ref, classId) async {
  final classValue = await ref.watch(apiClientProvider).academics.getClass(classId: classId);
  return classValue.code;
});

/// Room code by room id, from the one room-directory list call the screen needs. `GET
/// /api/academics/rooms` has no by-id form, so this fetches the (small) directory once and indexes
/// it.
final _roomCodesProvider = FutureProvider.autoDispose<Map<String, String>>((ref) async {
  final page = await ref.watch(apiClientProvider).academics.listRooms(limit: 200);
  return {for (final room in page.rooms) room.id: room.code};
});

/// One weekday of the visible week: its date header, then its periods in order, then any exams
/// that day overlaid beneath them.
class TimetableDaySection extends StatelessWidget {
  const TimetableDaySection({required this.day, super.key});

  final TimetableDay day;

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
              style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.space8),
        for (final slot in day.slots)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.space4),
            child: _SlotRow(slot: slot),
          ),
        for (final exam in day.exams)
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.space4),
            child: _ExamRow(exam: exam),
          ),
      ],
    );
  }
}

class _SlotRow extends ConsumerWidget {
  const _SlotRow({required this.slot});

  final TimetableSlot slot;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final classCode = ref.watch(_classCodeProvider(slot.classId));
    final roomCodes = ref.watch(_roomCodesProvider);
    final teacherName = ref.watch(timetableTeacherNameProvider(slot.teacherId));

    final roomCode = roomCodes.valueOrNull?[slot.roomId];
    final meta = [
      if (roomCode != null) 'timetable.slot.room'.tr(namedArgs: {'room': roomCode}),
      if (teacherName != null) teacherName,
    ].join('  ·  ');

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 28,
          child: Text(
            '${slot.period}',
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.primary,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        const SizedBox(width: AppSpacing.space8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              classCode.when(
                loading: () => Text(
                  'timetable.slot.unknownClass'.tr(),
                  style: theme.textTheme.bodyMedium,
                ),
                error: (error, stackTrace) => Text(
                  'timetable.slot.unknownClass'.tr(),
                  style: theme.textTheme.bodyMedium,
                ),
                data: (code) => Text(code, style: theme.textTheme.bodyMedium),
              ),
              if (meta.isNotEmpty)
                Text(
                  meta,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ExamRow extends ConsumerWidget {
  const _ExamRow({required this.exam});

  final Exam exam;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final locale = context.locale.toString();
    final roomCodes = ref.watch(_roomCodesProvider);

    final startsAt = exam.startsAt.toLocal();
    final endsAt = exam.endsAt.toLocal();
    final roomId = exam.roomId;
    final roomCode = roomId == null ? null : roomCodes.valueOrNull?[roomId];
    final meta = [
      '${DateFormat.jm(locale).format(startsAt)} – ${DateFormat.jm(locale).format(endsAt)}',
      if (roomCode != null) 'timetable.slot.room'.tr(namedArgs: {'room': roomCode}),
    ].join('  ·  ');

    return DecoratedBox(
      decoration: BoxDecoration(
        color: theme.colorScheme.secondaryContainer,
        borderRadius: AppRadius.mdRadius,
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space12,
          vertical: AppSpacing.space8,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              Icons.fact_check_outlined,
              size: 18,
              color: theme.colorScheme.onSecondaryContainer,
            ),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'timetable.exam'.tr(namedArgs: {'title': exam.title}),
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                      color: theme.colorScheme.onSecondaryContainer,
                    ),
                  ),
                  Text(
                    meta,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSecondaryContainer,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
