import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/session.dart';
import '../../../core/api/generated/models/session_channel.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/localization/relative_time.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/account_settings_providers.dart';

/// "Signed-in devices": every live session of the signed-in user, with this device marked and
/// kept out of the sign-out actions (Profile's Log out ends it). Any other session can be ended on
/// its own, or all of them at once.
class SignedInDevicesScreen extends ConsumerStatefulWidget {
  const SignedInDevicesScreen({super.key});

  @override
  ConsumerState<SignedInDevicesScreen> createState() =>
      _SignedInDevicesScreenState();
}

class _SignedInDevicesScreenState extends ConsumerState<SignedInDevicesScreen> {
  /// Ids of sessions being ended, or `{'*'}` while all others are.
  final Set<String> _busy = {};

  Future<void> _run(Set<String> ids, Future<void> Function() action) async {
    setState(() => _busy.addAll(ids));
    try {
      await action();
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('account.devices.failed'.tr())));
      }
    } finally {
      if (mounted) setState(() => _busy.removeAll(ids));
    }
  }

  Future<void> _signOutOthers(List<Session> sessions) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('account.devices.signOutOthers.title'.tr()),
        content: Text('account.devices.signOutOthers.body'.tr()),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text('account.devices.signOutOthers.cancel'.tr()),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text('account.devices.signOutOthers.confirm'.tr()),
          ),
        ],
      ),
    );
    if (!(confirmed ?? false) || !mounted) return;
    await _run({'*'}, () => ref.read(signOutOtherSessionsProvider)(sessions));
  }

  @override
  Widget build(BuildContext context) {
    final sessions = ref.watch(signedInSessionsProvider);
    final currentId = ref.watch(authSessionProvider).sessionId;

    return Scaffold(
      appBar: AppBar(title: Text('account.devices.title'.tr())),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(signedInSessionsProvider.future),
        child: sessions.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (_, _) => ListView(
            padding: const EdgeInsets.all(AppSpacing.space24),
            children: [
              Text(
                'account.devices.loadError'.tr(),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.space12),
              Center(
                child: OutlinedButton(
                  onPressed: () => ref.invalidate(signedInSessionsProvider),
                  child: Text('account.retry'.tr()),
                ),
              ),
            ],
          ),
          data: (sessions) {
            final hasOthers = sessions.any(
              (session) => session.id != currentId,
            );
            return ListView(
              padding: const EdgeInsets.all(
                AppSpacing.space16,
              ).withBottomInset(context),
              children: [
                Text(
                  'account.devices.intro'.tr(),
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                const SizedBox(height: AppSpacing.space16),
                Card(
                  margin: EdgeInsets.zero,
                  clipBehavior: Clip.antiAlias,
                  child: Column(
                    children: [
                      for (final (index, session) in sessions.indexed) ...[
                        if (index > 0) const Divider(height: 1),
                        _SessionTile(
                          session: session,
                          isCurrent: session.id == currentId,
                          busy:
                              _busy.contains(session.id) || _busy.contains('*'),
                          onSignOut: () => _run(
                            {session.id},
                            () => ref.read(signOutSessionProvider)(session.id),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                if (hasOthers) ...[
                  const SizedBox(height: AppSpacing.space24),
                  OutlinedButton.icon(
                    key: const Key('signOutOtherSessions'),
                    onPressed: _busy.isEmpty
                        ? () => _signOutOthers(sessions)
                        : null,
                    icon: const Icon(Icons.logout),
                    label: Text('account.devices.signOutOthers.action'.tr()),
                  ),
                ],
              ],
            );
          },
        ),
      ),
    );
  }
}

class _SessionTile extends StatelessWidget {
  const _SessionTile({
    required this.session,
    required this.isCurrent,
    required this.busy,
    required this.onSignOut,
  });

  final Session session;
  final bool isCurrent;
  final bool busy;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final name = session.deviceName?.trim();

    return ListTile(
      leading: Icon(switch (session.channel) {
        SessionChannel.web => Icons.laptop_outlined,
        SessionChannel.mobile => Icons.smartphone_outlined,
        _ => Icons.devices_other_outlined,
      }),
      title: Text(
        name != null && name.isNotEmpty
            ? name
            : 'account.devices.channel.${session.channel == SessionChannel.$unknown ? 'api' : session.channel.name}'
                  .tr(),
      ),
      subtitle: Text(
        'account.devices.signedIn'.tr(
          namedArgs: {'when': relativeTimeLabel(session.issuedAt)},
        ),
      ),
      trailing: isCurrent
          ? Text(
              'account.devices.thisDevice'.tr(),
              style: TextStyle(
                color: colorScheme.primary,
                fontWeight: FontWeight.w600,
              ),
            )
          : busy
          ? const SizedBox.square(
              dimension: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : TextButton(
              onPressed: onSignOut,
              child: Text('account.devices.signOut'.tr()),
            ),
    );
  }
}
