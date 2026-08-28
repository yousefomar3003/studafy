import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/announcement.dart';
import '../../../../core/offline/staleness_banner.dart';
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

  final Announcement announcement;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  announcement.title,
                  style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (announcement.mandatory) ...[
                const SizedBox(width: AppSpacing.space8),
                Icon(Icons.priority_high, size: 16, color: colorScheme.error),
              ],
            ],
          ),
          Text(
            announcement.body,
            style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}
