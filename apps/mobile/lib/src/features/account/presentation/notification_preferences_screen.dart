import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/notification_preference.dart';
import '../../../core/api/generated/models/notification_preference_channel.dart';
import '../../../core/api/generated/models/notification_preferences.dart';
import '../../../core/api/generated/models/notification_quiet_hours.dart';
import '../../../core/push/push_providers.dart';
import '../../../core/push/push_service.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../shell/application/shell_providers.dart';
import '../application/account_settings_providers.dart';

/// The groups the switches are offered in. Each covers several of the server's notification types,
/// so one switch means one thing a person recognises ("Grades"), not a list of internal events.
enum NotificationCategory {
  assignments(Icons.assignment_outlined),
  grades(Icons.grade_outlined),
  attendance(Icons.event_available_outlined),
  messages(Icons.chat_bubble_outline),
  announcements(Icons.campaign_outlined),
  fees(Icons.receipt_long_outlined),
  schoolUpdates(Icons.school_outlined);

  const NotificationCategory(this.icon);

  final IconData icon;
}

/// Which [NotificationCategory] a server notification type (its JSON name) belongs to.
NotificationCategory notificationCategoryOf(String type) => switch (type) {
  'ASSIGNMENT_DUE_SOON' ||
  'ASSIGNMENT_PUBLISHED' => NotificationCategory.assignments,
  'GRADE_POSTED' ||
  'ASSIGNMENT_GRADED' ||
  'CERTIFICATE_ISSUED' => NotificationCategory.grades,
  'ATTENDANCE_ALERT' || 'ATTENDANCE_MARKED' => NotificationCategory.attendance,
  'DIRECT_MESSAGE' ||
  'DISCUSSION_REPLY' ||
  'SUPPORT_MESSAGE' ||
  'STUDY_GROUP_INVITE' => NotificationCategory.messages,
  'ANNOUNCEMENT' || 'ADMIN_ANNOUNCEMENT' => NotificationCategory.announcements,
  _ when type.startsWith('FEE_') || type.startsWith('LICENSE_') =>
    NotificationCategory.fees,
  _ => NotificationCategory.schoolUpdates,
};

/// Notification types only a teacher who uploads materials receives.
bool _isTeachingOnly(String type) => type.startsWith('MATERIAL_');

/// Which categories a person with these role claims is offered. Fees are for parents and the
/// people who run the school's money; attendance is for families, students and the office.
Set<NotificationCategory> visibleCategories(Iterable<String> roleClaims) {
  final set = roleClaims.toSet();
  bool any(List<String> wanted) => wanted.any(set.contains);
  return {
    NotificationCategory.assignments,
    NotificationCategory.grades,
    if (any(['PARENT', 'STUDENT', 'ATTENDANCE_OFFICER']))
      NotificationCategory.attendance,
    NotificationCategory.messages,
    NotificationCategory.announcements,
    if (any(['PARENT', 'FINANCE', 'PRINCIPAL', 'ORG_ADMIN']))
      NotificationCategory.fees,
    NotificationCategory.schoolUpdates,
  };
}

/// One category's switch for one channel: on when every type in it is on, locked when the school
/// makes all of them mandatory.
class _CategoryChannel {
  _CategoryChannel(this.cells);

  final List<NotificationPreference> cells;

  bool get locked => cells.every((cell) => cell.mandatory);
  bool get enabled => cells.every((cell) => cell.enabled || cell.mandatory);
}

/// "Notifications" in Profile: whether this phone shows them, a test button, one switch per kind of
/// notice for the phone and for email, and quiet hours. Everything always lands in the inbox (the
/// bell), so the switches only decide what interrupts.
class NotificationPreferencesScreen extends ConsumerStatefulWidget {
  const NotificationPreferencesScreen({super.key});

  @override
  ConsumerState<NotificationPreferencesScreen> createState() =>
      _NotificationPreferencesScreenState();
}

class _NotificationPreferencesScreenState
    extends ConsumerState<NotificationPreferencesScreen>
    with WidgetsBindingObserver {
  /// The latest matrix the server returned from a save; wins over the initial load.
  NotificationPreferences? _saved;
  NotificationQuietHours? _savedQuietHours;
  final Set<String> _saving = {};
  bool _sendingTest = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // Back from the Settings app: the permission may have changed.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.invalidate(pushPermissionProvider);
    }
  }

  void _snack(String key) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(key.tr())));
  }

  Future<void> _toggle(
    NotificationCategory category,
    String channel,
    _CategoryChannel switchState,
    bool enabled,
  ) async {
    final key = '${category.name}/$channel';
    setState(() => _saving.add(key));
    try {
      final updated = await ref.read(updateNotificationPreferencesProvider)([
        for (final cell in switchState.cells)
          if (!cell.mandatory)
            (
              type: cell.notificationType.json!,
              channel: cell.channel.json!,
              enabled: enabled,
            ),
      ]);
      if (mounted) setState(() => _saved = updated);
    } on Object {
      _snack('account.notifications.saveFailed');
    } finally {
      if (mounted) setState(() => _saving.remove(key));
    }
  }

  Future<void> _turnOnPhone() async {
    final push = ref.read(pushServiceProvider);
    try {
      await push.requestPermission();
    } catch (_) {
      // Shown through the status below.
    }
    ref.invalidate(pushPermissionProvider);
    // The shell's "turn on notifications" banner no longer needs to ask.
    ref.read(pushSetupProvider.notifier).accountChanged();
  }

  Future<void> _sendTest() async {
    setState(() => _sendingTest = true);
    try {
      // Registers again first, so a phone whose token changed is reachable before the send.
      await ref.read(pushServiceProvider).registerIfAuthenticated();
      await ref.read(sendTestNotificationProvider)();
      _snack('account.notifications.phone.testSent');
    } on Object {
      _snack('account.notifications.phone.testFailed');
    } finally {
      if (mounted) setState(() => _sendingTest = false);
    }
  }

  Future<void> _setQuietHours(String? start, String? end) async {
    setState(() => _saving.add('quiet'));
    try {
      final updated = await ref.read(updateQuietHoursProvider)(start, end);
      if (mounted) setState(() => _savedQuietHours = updated);
    } on Object {
      _snack('account.notifications.saveFailed');
    } finally {
      if (mounted) setState(() => _saving.remove('quiet'));
    }
  }

  Future<void> _pickTime(
    NotificationQuietHours current, {
    required bool start,
  }) async {
    final value = start ? current.start : current.end;
    final picked = await showTimePicker(
      context: context,
      initialTime: _parse(value) ?? TimeOfDay(hour: start ? 22 : 7, minute: 0),
    );
    if (picked == null || !mounted) return;
    final text = _format(picked);
    final other = start ? current.end : current.start;
    if (other == text) return;
    await _setQuietHours(
      start ? text : current.start,
      start ? current.end : text,
    );
  }

  static TimeOfDay? _parse(String? value) {
    if (value == null) return null;
    final parts = value.split(':');
    if (parts.length != 2) return null;
    return TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1]));
  }

  static String _format(TimeOfDay time) =>
      '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final loaded = ref.watch(accountNotificationPreferencesProvider);
    final roles = ref.watch(sessionRolesProvider);

    return Scaffold(
      appBar: AppBar(title: Text('account.notifications.title'.tr())),
      body: ListView(
        padding: const EdgeInsets.all(
          AppSpacing.space16,
        ).withBottomInset(context),
        children: [
          _PhoneCard(
            sendingTest: _sendingTest,
            onTurnOn: _turnOnPhone,
            onOpenSettings: () =>
                ref.read(pushServiceProvider).openSystemSettings(),
            onSendTest: _sendTest,
          ),
          const SizedBox(height: AppSpacing.space24),
          _SectionTitle('account.notifications.kinds.title'.tr()),
          const SizedBox(height: AppSpacing.space4),
          Text(
            'account.notifications.kinds.intro'.tr(),
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: AppSpacing.space12),
          loaded.when(
            loading: () => const Padding(
              padding: EdgeInsets.all(AppSpacing.space24),
              child: Center(child: CircularProgressIndicator()),
            ),
            error: (_, _) => _RetryCard(
              messageKey: 'account.notifications.loadError',
              onRetry: () =>
                  ref.invalidate(accountNotificationPreferencesProvider),
            ),
            data: (initial) => _KindsCard(
              grouped: _group(
                (_saved ?? initial).preferences,
                categories: visibleCategories(roles),
                includeTeaching: roles.contains('INSTRUCTOR'),
              ),
              saving: _saving,
              onToggle: _toggle,
            ),
          ),
          const SizedBox(height: AppSpacing.space24),
          _SectionTitle('account.notifications.quiet.title'.tr()),
          const SizedBox(height: AppSpacing.space12),
          ref
              .watch(notificationQuietHoursProvider)
              .when(
                loading: () => const SizedBox.shrink(),
                error: (_, _) => _RetryCard(
                  messageKey: 'account.notifications.loadError',
                  onRetry: () => ref.invalidate(notificationQuietHoursProvider),
                ),
                data: (initial) {
                  final current = _savedQuietHours ?? initial;
                  return _QuietHoursCard(
                    current: current,
                    saving: _saving.contains('quiet'),
                    onEnable: (on) => on
                        ? _setQuietHours('22:00', '07:00')
                        : _setQuietHours(null, null),
                    onPickStart: () => _pickTime(current, start: true),
                    onPickEnd: () => _pickTime(current, start: false),
                  );
                },
              ),
        ],
      ),
    );
  }

  /// The visible categories, each with its push and email switch (null when the category has no
  /// cell on that channel). Types this build doesn't know are left out.
  static Map<NotificationCategory, Map<String, _CategoryChannel>> _group(
    List<NotificationPreference> cells, {
    required Set<NotificationCategory> categories,
    required bool includeTeaching,
  }) {
    final byCategory =
        <NotificationCategory, Map<String, List<NotificationPreference>>>{};
    for (final cell in cells) {
      final type = cell.notificationType.json;
      final channel = cell.channel.json;
      if (type == null || channel == null) continue;
      if (cell.channel == NotificationPreferenceChannel.inApp) continue;
      if (_isTeachingOnly(type) && !includeTeaching) continue;
      final category = notificationCategoryOf(type);
      if (!categories.contains(category)) continue;
      byCategory
          .putIfAbsent(category, () => {})
          .putIfAbsent(channel, () => [])
          .add(cell);
    }
    return {
      for (final category in NotificationCategory.values)
        if (byCategory[category] case final channels?)
          category: {
            for (final MapEntry(key: channel, value: list) in channels.entries)
              channel: _CategoryChannel(list),
          },
    };
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) =>
      Text(text, style: Theme.of(context).textTheme.titleMedium);
}

class _RetryCard extends StatelessWidget {
  const _RetryCard({required this.messageKey, required this.onRetry});

  final String messageKey;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Row(
          children: [
            Expanded(child: Text(messageKey.tr())),
            TextButton(onPressed: onRetry, child: Text('account.retry'.tr())),
          ],
        ),
      ),
    );
  }
}

/// Whether this phone shows notifications, and the one action that fits.
class _PhoneCard extends ConsumerWidget {
  const _PhoneCard({
    required this.sendingTest,
    required this.onTurnOn,
    required this.onOpenSettings,
    required this.onSendTest,
  });

  final bool sendingTest;
  final VoidCallback onTurnOn;
  final VoidCallback onOpenSettings;
  final VoidCallback onSendTest;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final status = ref.watch(pushPermissionProvider).value;
    final (icon, color, key) = switch (status) {
      PushPermission.granted => (
        Icons.notifications_active_outlined,
        theme.colorScheme.primary,
        'on',
      ),
      PushPermission.denied => (
        Icons.notifications_off_outlined,
        theme.colorScheme.error,
        'off',
      ),
      PushPermission.notDetermined => (
        Icons.notifications_none_outlined,
        theme.colorScheme.onSurfaceVariant,
        'notAsked',
      ),
      PushPermission.unavailable => (
        Icons.notifications_off_outlined,
        theme.colorScheme.onSurfaceVariant,
        'unavailable',
      ),
      null => (
        Icons.notifications_none_outlined,
        theme.colorScheme.onSurfaceVariant,
        'checking',
      ),
    };

    return Card(
      key: const Key('notificationPhoneCard'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(icon, color: color),
                const SizedBox(width: AppSpacing.space12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'account.notifications.phone.title'.tr(),
                        style: theme.textTheme.titleSmall,
                      ),
                      Text(
                        'account.notifications.phone.$key'.tr(),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space12),
            switch (status) {
              PushPermission.granted => OutlinedButton.icon(
                key: const Key('notificationSendTest'),
                onPressed: sendingTest ? null : onSendTest,
                icon: const Icon(Icons.send_outlined),
                label: Text('account.notifications.phone.sendTest'.tr()),
              ),
              PushPermission.denied => FilledButton.icon(
                key: const Key('notificationOpenSettings'),
                onPressed: onOpenSettings,
                icon: const Icon(Icons.settings_outlined),
                label: Text('account.notifications.phone.openSettings'.tr()),
              ),
              PushPermission.notDetermined => FilledButton(
                key: const Key('notificationTurnOn'),
                onPressed: onTurnOn,
                child: Text('account.notifications.phone.turnOn'.tr()),
              ),
              _ => const SizedBox.shrink(),
            },
          ],
        ),
      ),
    );
  }
}

/// One row per kind of notice, with a "Phone" and an "Email" switch.
class _KindsCard extends StatelessWidget {
  const _KindsCard({
    required this.grouped,
    required this.saving,
    required this.onToggle,
  });

  final Map<NotificationCategory, Map<String, _CategoryChannel>> grouped;
  final Set<String> saving;
  final Future<void> Function(
    NotificationCategory,
    String,
    _CategoryChannel,
    bool,
  )
  onToggle;

  static const _channels = ['push', 'email'];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.labelSmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );

    return Card(
      margin: EdgeInsets.zero,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.space16,
              AppSpacing.space12,
              AppSpacing.space8,
              0,
            ),
            child: Row(
              children: [
                const Expanded(child: SizedBox.shrink()),
                for (final channel in _channels)
                  SizedBox(
                    width: 64,
                    child: Text(
                      'account.notifications.channels.$channel'.tr(),
                      textAlign: TextAlign.center,
                      style: muted,
                    ),
                  ),
              ],
            ),
          ),
          for (final (index, MapEntry(key: category, value: channels))
              in grouped.entries.indexed) ...[
            if (index > 0) const Divider(height: 1, indent: 56),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.space16,
                AppSpacing.space8,
                AppSpacing.space8,
                AppSpacing.space8,
              ),
              child: Row(
                children: [
                  Icon(category.icon, color: theme.colorScheme.primary),
                  const SizedBox(width: AppSpacing.space16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'account.notifications.kinds.${category.name}.title'
                              .tr(),
                          style: theme.textTheme.bodyLarge,
                        ),
                        Text(
                          channels.values.every((c) => c.locked)
                              ? 'account.notifications.mandatory'.tr()
                              : 'account.notifications.kinds.${category.name}.subtitle'
                                    .tr(),
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                  for (final channel in _channels)
                    SizedBox(
                      width: 64,
                      child: switch (channels[channel]) {
                        final switchState? => Switch(
                          key: Key(
                            'notificationPref-${category.name}/$channel',
                          ),
                          value: switchState.enabled,
                          onChanged:
                              switchState.locked ||
                                  saving.contains('${category.name}/$channel')
                              ? null
                              : (on) => onToggle(
                                  category,
                                  channel,
                                  switchState,
                                  on,
                                ),
                        ),
                        null => const SizedBox.shrink(),
                      },
                    ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _QuietHoursCard extends StatelessWidget {
  const _QuietHoursCard({
    required this.current,
    required this.saving,
    required this.onEnable,
    required this.onPickStart,
    required this.onPickEnd,
  });

  final NotificationQuietHours current;
  final bool saving;
  final ValueChanged<bool> onEnable;
  final VoidCallback onPickStart;
  final VoidCallback onPickEnd;

  @override
  Widget build(BuildContext context) {
    final on = current.start != null && current.end != null;
    return Card(
      margin: EdgeInsets.zero,
      child: Column(
        children: [
          SwitchListTile(
            key: const Key('notificationQuietHours'),
            title: Text('account.notifications.quiet.toggle'.tr()),
            subtitle: Text('account.notifications.quiet.subtitle'.tr()),
            value: on,
            onChanged: saving ? null : onEnable,
          ),
          if (on) ...[
            const Divider(height: 1),
            ListTile(
              key: const Key('notificationQuietFrom'),
              title: Text('account.notifications.quiet.from'.tr()),
              trailing: Text(
                current.start!,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              onTap: saving ? null : onPickStart,
            ),
            ListTile(
              key: const Key('notificationQuietUntil'),
              title: Text('account.notifications.quiet.until'.tr()),
              trailing: Text(
                current.end!,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              subtitle: Text(
                'account.notifications.quiet.timezone'.tr(
                  namedArgs: {'zone': current.timezone},
                ),
              ),
              onTap: saving ? null : onPickEnd,
            ),
          ],
        ],
      ),
    );
  }
}
