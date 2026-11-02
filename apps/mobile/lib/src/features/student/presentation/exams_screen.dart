import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/offline/staleness_banner.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/exams_providers.dart';
import '../domain/upcoming_exams.dart';
import 'widgets/exam_day_section.dart';
import 'widgets/exams_placeholders.dart';

/// The student's upcoming-exams calendar: every not-yet-finished exam for their enrolled
/// classes, grouped by day ascending, each showing its scope (class), room, gradebook weight and
/// a link into that class's study materials.
///
/// Served from the offline cache first (see [enrolledClassExamsProvider]) so a list already
/// viewed still shows with no connectivity, marked stale. Until a self-scoped enrolments
/// endpoint exists (`student_context_providers.dart`) the real app shows the "not available yet"
/// state; the populated states are exercised by overriding that seam.
class StudentExamsScreen extends ConsumerWidget {
  const StudentExamsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(examsAgendaProvider);

    return Scaffold(
      appBar: AppBar(title: Text('exams.title'.tr())),
      body: RefreshIndicator(
        onRefresh: () async {
          ref
            ..invalidate(enrolledClassExamsProvider)
            ..invalidate(examRoomDirectoryProvider);
        },
        child: status.when(
          loading: () => const ExamsSkeleton(),
          error: (error, stackTrace) => const ExamsMessage(
            messageKey: 'exams.error',
            icon: Icons.error_outline,
          ),
          data: (agendaStatus) => switch (agendaStatus) {
            ExamsAgendaUnavailable() => const ExamsMessage(
              messageKey: 'exams.unavailable',
              icon: Icons.info_outline,
            ),
            ExamsAgendaReady(value: final cached) when cached.data.isEmpty => const ExamsMessage(
              messageKey: 'exams.empty',
              hintKey: 'exams.emptyHint',
              icon: Icons.event_available_outlined,
            ),
            ExamsAgendaReady(value: final cached) => ListView(
              padding: const EdgeInsets.all(AppSpacing.space16),
              physics: const AlwaysScrollableScrollPhysics(),
              children: [
                if (cached.isStale) ...[
                  StalenessBanner(fetchedAt: cached.fetchedAt),
                  const SizedBox(height: AppSpacing.space16),
                ],
                for (final day in cached.data.days) ...[
                  ExamDaySection(day: day),
                  const SizedBox(height: AppSpacing.space24),
                ],
              ],
            ),
          },
        ),
      ),
    );
  }
}
