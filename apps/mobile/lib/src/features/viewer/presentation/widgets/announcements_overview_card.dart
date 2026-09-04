import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/localization/relative_time.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/viewer_providers.dart';
import 'viewer_section_card.dart';

/// The most recently published school announcements.
class AnnouncementsOverviewCard extends ConsumerWidget {
  const AnnouncementsOverviewCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final announcements = ref.watch(viewerRecentAnnouncementsProvider);
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return ViewerSectionCard(
      titleKey: 'viewer.admin.announcements.title',
      icon: Icons.campaign_outlined,
      child: announcements.when(
        loading: () => const ViewerCardSkeleton(),
        error: (error, stackTrace) => const ViewerCardMessage(
          messageKey: 'viewer.admin.announcements.error',
          icon: Icons.error_outline,
        ),
        data: (items) {
          if (items.isEmpty) {
            return const ViewerCardMessage(
              messageKey: 'viewer.admin.announcements.empty',
              icon: Icons.info_outline,
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final announcement in items) ...[
                Text(announcement.title, style: textTheme.bodyLarge),
                if (announcement.publishedAt != null)
                  Text(
                    relativeTimeLabel(announcement.publishedAt!),
                    style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
                  ),
                if (announcement != items.last) const SizedBox(height: AppSpacing.space8),
              ],
            ],
          );
        },
      ),
    );
  }
}
