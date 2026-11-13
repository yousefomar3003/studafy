import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../application/parent_providers.dart';
import '../parent_communication_screen.dart';
import 'notification_feed_tile.dart';
import 'parent_section_card.dart';

/// The combined notifications feed: the most recent notices across every linked child plus
/// account-level ones, unread marked with a leading dot. Tapping one marks it read. The header
/// action opens [ParentCommunicationScreen] for the full, split-by-kind history.
class ParentNotificationsCard extends ConsumerWidget {
  const ParentNotificationsCard({this.maxItems = 6, super.key});

  final int maxItems;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ParentSectionCard(
      titleKey: 'parent.notifications.title',
      icon: Icons.notifications_none_outlined,
      trailing: IconButton(
        icon: const Icon(Icons.arrow_forward),
        tooltip: 'parent.communication.viewAll'.tr(),
        onPressed: () => Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => const ParentCommunicationScreen()),
        ),
      ),
      child: ref.watch(parentNotificationsProvider).when(
            loading: () => const ParentCardSkeleton(),
            error: (_, _) => const ParentCardMessage(
              messageKey: 'parent.notifications.error',
              icon: Icons.error_outline,
            ),
            data: (feed) {
              if (feed.isEmpty) {
                return const ParentCardMessage(
                  messageKey: 'parent.notifications.empty',
                  icon: Icons.check_circle_outline,
                );
              }
              return Column(
                children: [
                  for (final notification in feed.take(maxItems))
                    NotificationFeedTile(notification: notification),
                ],
              );
            },
          ),
    );
  }
}
