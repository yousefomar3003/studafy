import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/notification_preference.dart';
import '../../../core/api/generated/models/notification_preference_channel.dart';
import '../../../core/api/generated/models/notification_preference_notification_type.dart';
import '../../../core/api/generated/models/notification_preference_update.dart';
import '../../../core/api/generated/models/notification_preference_update_channel.dart';
import '../../../core/api/generated/models/notification_preference_update_notification_type.dart';
import '../../../core/api/generated/models/notification_preferences.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../shell/application/shell_providers.dart';
import '../../shell/domain/app_role.dart';
import '../application/account_settings_providers.dart';

/// The groups the notification settings are listed under, in display order.
enum NotificationCategory { academic, communications, family, teaching }

/// Which [NotificationCategory] a notification type is listed under. The material-pipeline types
/// only concern the teacher who uploaded the file, so they form their own "teaching" group.
NotificationCategory notificationCategoryOf(
  NotificationPreferenceNotificationType type,
) => switch (type) {
  NotificationPreferenceNotificationType.assignmentDueSoon ||
  NotificationPreferenceNotificationType.gradePosted ||
  NotificationPreferenceNotificationType.enrollmentApproved ||
  NotificationPreferenceNotificationType.coursePublished ||
  NotificationPreferenceNotificationType.certificateIssued =>
    NotificationCategory.academic,
  NotificationPreferenceNotificationType.attendanceAlert =>
    NotificationCategory.family,
  NotificationPreferenceNotificationType.materialScanQuarantined ||
  NotificationPreferenceNotificationType.materialScanFailed ||
  NotificationPreferenceNotificationType.materialOcrLowConfidence ||
  NotificationPreferenceNotificationType.materialIngested ||
  NotificationPreferenceNotificationType.materialIngestFailed =>
    NotificationCategory.teaching,
  _ => NotificationCategory.communications,
};

/// "Notifications": which notification types reach the signed-in user in the app, by push and by
/// email (`/api/notification-preferences`). Each switch saves on its own; a type the school makes
/// mandatory shows its switches locked on. The teaching group is shown to teachers only.
class NotificationPreferencesScreen extends ConsumerStatefulWidget {
  const NotificationPreferencesScreen({super.key});

  @override
  ConsumerState<NotificationPreferencesScreen> createState() =>
      _NotificationPreferencesScreenState();
}

class _NotificationPreferencesScreenState
    extends ConsumerState<NotificationPreferencesScreen> {
  /// The latest matrix the server returned from a save; wins over the initial load.
  NotificationPreferences? _saved;
  final Set<String> _saving = {};

  static String _cellKey(NotificationPreference cell) =>
      '${cell.notificationType.json}/${cell.channel.json}';

  Future<void> _toggle(NotificationPreference cell, bool enabled) async {
    final key = _cellKey(cell);
    setState(() => _saving.add(key));
    try {
      final updated = await ref.read(updateNotificationPreferenceProvider)(
        NotificationPreferenceUpdate(
          notificationType:
              NotificationPreferenceUpdateNotificationType.fromJson(
                cell.notificationType.json!,
              ),
          channel: NotificationPreferenceUpdateChannel.fromJson(
            cell.channel.json!,
          ),
          enabled: enabled,
        ),
      );
      if (mounted) setState(() => _saved = updated);
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('account.notifications.saveFailed'.tr())),
        );
      }
    } finally {
      if (mounted) setState(() => _saving.remove(key));
    }
  }

  @override
  Widget build(BuildContext context) {
    final loaded = ref.watch(accountNotificationPreferencesProvider);
    final isTeacher = ref
        .watch(sessionRolesProvider)
        .map(AppRole.fromClaim)
        .contains(AppRole.instructor);

    return Scaffold(
      appBar: AppBar(title: Text('account.notifications.title'.tr())),
      body: loaded.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.space24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'account.notifications.loadError'.tr(),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: AppSpacing.space12),
                OutlinedButton(
                  onPressed: () =>
                      ref.invalidate(accountNotificationPreferencesProvider),
                  child: Text('account.retry'.tr()),
                ),
              ],
            ),
          ),
        ),
        data: (initial) {
          final grouped = _group(
            (_saved ?? initial).preferences,
            includeTeaching: isTeacher,
          );
          return ListView(
            padding: const EdgeInsets.all(
              AppSpacing.space16,
            ).withBottomInset(context),
            children: [
              Text(
                'account.notifications.intro'.tr(),
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              for (final MapEntry(key: category, value: types)
                  in grouped.entries) ...[
                const SizedBox(height: AppSpacing.space24),
                Text(
                  'account.notifications.categories.${category.name}'.tr(),
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                const SizedBox(height: AppSpacing.space8),
                Card(
                  margin: EdgeInsets.zero,
                  child: Column(
                    children: [
                      for (final (index, MapEntry(key: type, value: cells))
                          in types.entries.indexed) ...[
                        if (index > 0) const Divider(height: 1),
                        _TypeRow(
                          type: type,
                          cells: cells,
                          saving: _saving,
                          cellKey: _cellKey,
                          onToggle: _toggle,
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ],
          );
        },
      ),
    );
  }

  /// Groups the matrix by category, then by type, keeping each type's channels in
  /// in-app/push/email order. Types this build doesn't know are left out.
  static Map<
    NotificationCategory,
    Map<NotificationPreferenceNotificationType, List<NotificationPreference>>
  >
  _group(List<NotificationPreference> cells, {required bool includeTeaching}) {
    final result = {
      for (final category in NotificationCategory.values)
        category:
            <
              NotificationPreferenceNotificationType,
              List<NotificationPreference>
            >{},
    };
    for (final cell in cells) {
      if (cell.notificationType ==
              NotificationPreferenceNotificationType.$unknown ||
          cell.channel == NotificationPreferenceChannel.$unknown) {
        continue;
      }
      final category = notificationCategoryOf(cell.notificationType);
      if (category == NotificationCategory.teaching && !includeTeaching) {
        continue;
      }
      result[category]!.putIfAbsent(cell.notificationType, () => []).add(cell);
    }
    for (final types in result.values) {
      for (final channels in types.values) {
        channels.sort((a, b) => a.channel.index.compareTo(b.channel.index));
      }
    }
    result.removeWhere((_, types) => types.isEmpty);
    return result;
  }
}

class _TypeRow extends StatelessWidget {
  const _TypeRow({
    required this.type,
    required this.cells,
    required this.saving,
    required this.cellKey,
    required this.onToggle,
  });

  final NotificationPreferenceNotificationType type;
  final List<NotificationPreference> cells;
  final Set<String> saving;
  final String Function(NotificationPreference) cellKey;
  final Future<void> Function(NotificationPreference, bool) onToggle;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final mandatory = cells.any((cell) => cell.mandatory);

    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.space16,
        vertical: AppSpacing.space12,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'account.notifications.types.${type.name}'.tr(),
            style: textTheme.bodyLarge,
          ),
          if (mandatory)
            Text(
              'account.notifications.mandatory'.tr(),
              style: textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          const SizedBox(height: AppSpacing.space8),
          Wrap(
            spacing: AppSpacing.space8,
            runSpacing: AppSpacing.space8,
            children: [
              for (final cell in cells)
                FilterChip(
                  key: Key('notificationPref-${cellKey(cell)}'),
                  label: Text(
                    'account.notifications.channels.${cell.channel.name}'.tr(),
                  ),
                  selected: cell.enabled,
                  onSelected: cell.mandatory || saving.contains(cellKey(cell))
                      ? null
                      : (enabled) => onToggle(cell, enabled),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
