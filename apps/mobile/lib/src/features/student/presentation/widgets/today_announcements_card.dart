import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/notification.dart' as api_models;
import '../../../../core/offline/announcements_offline_repository.dart';
import '../../../../core/offline/staleness_banner.dart';
import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/today_providers.dart';
import 'today_card_shell.dart';
import 'today_skeleton.dart';
import 'today_state_message.dart';

/// The most recent announcements visible to this student.
class TodayAnnouncementsCard extends ConsumerWidget {
  const TodayAnnouncementsCard({this.maxItems = 5, super.key});

  final int maxItems;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final announcements = ref.watch(todayAnnouncementsProvider);

    return TodayCardShell(
      titleKey: 'today.announcements.title',
      icon: Icons.campaign_outlined,
      accent: AppAccent.violet,
      child: announcements.when(
        loading: () => const TodaySkeleton(),
        error: (error, stackTrace) => const TodayStateMessage(
          messageKey: 'today.announcements.error',
          icon: Icons.error_outline,
        ),
        data: (cached) {
          if (cached.data.isEmpty) {
            return const TodayStateMessage(
              messageKey: 'today.announcements.empty',
              icon: Icons.notifications_none,
            );
          }
          final items = cached.data.take(maxItems);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (cached.isStale) ...[
                StalenessBanner(fetchedAt: cached.fetchedAt),
                const SizedBox(height: AppSpacing.space12),
              ],
              for (final announcement in items) _AnnouncementRow(announcement: announcement),
            ],
          );
        },
      ),
    );
  }
}

class _AnnouncementRow extends StatelessWidget {
  const _AnnouncementRow({required this.announcement});

  final api_models.Notification announcement;

  @override
  Widget build(BuildContext context) {
    // A mandatory notice leads with the red "!" badge instead of the megaphone.
    final mandatory = isMandatoryAnnouncement(announcement);

    return AppIconListTile(
      icon: mandatory ? Icons.priority_high : Icons.campaign_outlined,
      accent: mandatory ? AppTone.danger.accent : AppAccent.violet,
      title: announcement.title,
      subtitle: announcement.body,
    );
  }
}
