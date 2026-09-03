import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

// Aliased: the generated `Notification` model collides with Flutter's own `Notification` widget,
// which `flutter/material.dart` brings into scope here.
import '../../../core/api/generated/models/notification.dart' as api_models;
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/parent_providers.dart';
import 'widgets/attendance_alert_threshold_sheet.dart';
import 'widgets/notification_feed_tile.dart';
import 'widgets/parent_section_card.dart';

/// School messages and attendance alerts, in one place: a "Messages" tab for announcements
/// addressed to the parent, and an "Alerts" tab for attendance-threshold breaches with a shortcut
/// to the threshold that raises them. Reached from the parent home's notifications card, and — for
/// the alerts tab specifically — from an `ATTENDANCE_ALERT` push notification's deep link (see
/// `PushService`).
class ParentCommunicationScreen extends StatelessWidget {
  const ParentCommunicationScreen({this.initialTabIndex = 0, super.key});

  /// Which tab opens first: 0 for messages, 1 for alerts.
  final int initialTabIndex;

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      initialIndex: initialTabIndex,
      child: Scaffold(
        appBar: AppBar(
          title: Text('parent.communication.title'.tr()),
          bottom: TabBar(
            tabs: [
              Tab(text: 'parent.communication.tabs.messages'.tr()),
              Tab(text: 'parent.communication.tabs.alerts'.tr()),
            ],
          ),
        ),
        body: const TabBarView(
          children: [_MessagesTab(), _AlertsTab()],
        ),
      ),
    );
  }
}

class _MessagesTab extends ConsumerWidget {
  const _MessagesTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final messages = ref.watch(schoolMessagesFeedProvider);

    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(parentCommunicationFeedProvider),
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          messages.when(
            loading: () => const _FeedSkeleton(),
            error: (_, _) => const _FeedMessage(
              messageKey: 'parent.communication.messages.error',
              icon: Icons.error_outline,
            ),
            data: (list) => list.isEmpty
                ? const _FeedMessage(
                    messageKey: 'parent.communication.messages.empty',
                    icon: Icons.check_circle_outline,
                  )
                : _FeedRows(notifications: list),
          ),
        ],
      ),
    );
  }
}

class _AlertsTab extends ConsumerWidget {
  const _AlertsTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final threshold = ref.watch(notificationPreferencesProvider).value?.attendanceAlertThreshold;
    final alerts = ref.watch(attendanceAlertsFeedProvider);

    return RefreshIndicator(
      onRefresh: () async {
        ref
          ..invalidate(parentCommunicationFeedProvider)
          ..invalidate(notificationPreferencesProvider);
      },
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          ParentSectionCard(
            titleKey: 'parent.communication.threshold.title',
            icon: Icons.tune,
            trailing: TextButton(
              onPressed: () => showAttendanceAlertThresholdSheet(context),
              child: Text('parent.communication.threshold.edit'.tr()),
            ),
            child: Text(
              threshold == null
                  ? 'parent.communication.threshold.usingSchoolDefault'.tr()
                  : 'parent.communication.threshold.customValue'.tr(
                      namedArgs: {'days': '$threshold'},
                    ),
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
          const SizedBox(height: AppSpacing.space16),
          alerts.when(
            loading: () => const _FeedSkeleton(),
            error: (_, _) => const _FeedMessage(
              messageKey: 'parent.communication.alerts.error',
              icon: Icons.error_outline,
            ),
            data: (list) => list.isEmpty
                ? const _FeedMessage(
                    messageKey: 'parent.communication.alerts.empty',
                    icon: Icons.check_circle_outline,
                  )
                : _FeedRows(notifications: list),
          ),
        ],
      ),
    );
  }
}

/// One notification per row, with a divider between — a plain [Column], not its own scrollable:
/// both tabs place this inside a single outer `ListView` they own (after a header card, on the
/// alerts tab), so nesting a second independently-scrolling list here would leave it with no
/// bounded height.
class _FeedRows extends StatelessWidget {
  const _FeedRows({required this.notifications});

  final List<api_models.Notification> notifications;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (var i = 0; i < notifications.length; i++) ...[
          if (i > 0) const Divider(),
          NotificationFeedTile(notification: notifications[i]),
        ],
      ],
    );
  }
}

class _FeedSkeleton extends StatelessWidget {
  const _FeedSkeleton();

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.surfaceContainerHighest;
    return Column(
      children: [
        for (var i = 0; i < 4; i++)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
            child: DecoratedBox(
              decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(4)),
              child: const SizedBox(height: 48, width: double.infinity),
            ),
          ),
      ],
    );
  }
}

class _FeedMessage extends StatelessWidget {
  const _FeedMessage({required this.messageKey, required this.icon});

  final String messageKey;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space32),
      child: Column(
        children: [
          Icon(icon, size: 32, color: colorScheme.onSurfaceVariant),
          const SizedBox(height: AppSpacing.space8),
          Text(
            messageKey.tr(),
            style: Theme.of(context)
                .textTheme
                .bodyMedium
                ?.copyWith(color: colorScheme.onSurfaceVariant),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}
