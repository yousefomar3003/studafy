import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/viewer_providers.dart';
import 'widgets/announcements_overview_card.dart';
import 'widgets/attendance_overview_card.dart';
import 'widgets/discipline_overview_card.dart';
import 'widgets/evaluations_overview_card.dart';

/// The Admin/Principal viewer summary: attendance, open discipline incidents, draft evaluations,
/// and recent announcements. Every card owns its own provider and loading/empty/error state, the
/// same pattern `TeacherHomeScreen` uses, so one slow endpoint never holds up the others.
///
/// Purely a read model — no card here links to a mutation, matching the shell's zero-mutation
/// posture for [ShellRole.viewer] (see `channelGuard.ts`'s doc comment on why some of this data's
/// siblings, like the finance reports and approvals queue, are web-only in the first place).
class AdminOverviewScreen extends ConsumerWidget {
  const AdminOverviewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      onRefresh: () async {
        ref
          ..invalidate(viewerAttendanceOverviewProvider)
          ..invalidate(viewerOpenDisciplineCountProvider)
          ..invalidate(viewerDraftEvaluationsCountProvider)
          ..invalidate(viewerRecentAnnouncementsProvider);
      },
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        children: const [
          AttendanceOverviewCard(),
          SizedBox(height: AppSpacing.space16),
          DisciplineOverviewCard(),
          SizedBox(height: AppSpacing.space16),
          EvaluationsOverviewCard(),
          SizedBox(height: AppSpacing.space16),
          AnnouncementsOverviewCard(),
        ],
      ),
    );
  }
}
