import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_notifier.dart';
import '../../../core/auth/saved_account.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import 'profile_tab_screen.dart' show profileRoleLabelKey;

/// One account in the switcher or on the login screen: initial, name, then school and role.
class AccountTile extends StatelessWidget {
  const AccountTile({
    required this.label,
    required this.roles,
    this.onTap,
    this.trailing,
    super.key,
  });

  final AccountLabel label;
  final List<String> roles;
  final VoidCallback? onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final name = accountName(label, roles);
    final details = [
      ?label.schoolName,
      profileRoleLabelKey(roles).tr(),
    ].join(' · ');

    return ListTile(
      contentPadding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.space16,
        vertical: AppSpacing.space4,
      ),
      leading: CircleAvatar(
        backgroundColor: colorScheme.primary,
        foregroundColor: colorScheme.onPrimary,
        child: ExcludeSemantics(
          child: Text(name.characters.first.toUpperCase()),
        ),
      ),
      title: Text(name, style: theme.textTheme.titleSmall),
      subtitle: Text(details),
      trailing: trailing,
      onTap: onTap,
    );
  }
}

/// The name an account is listed under: the person's name, else their member ID, else the role.
String accountName(AccountLabel label, List<String> roles) {
  final name = label.displayName?.trim();
  if (name != null && name.isNotEmpty) return name;
  if (label.memberIds.isNotEmpty) return label.memberIds.first;
  return profileRoleLabelKey(roles).tr();
}

/// What the person picked in the switcher.
sealed class _SwitcherChoice {
  const _SwitcherChoice();
}

class _SwitchTo extends _SwitcherChoice {
  const _SwitchTo(this.userId);
  final String userId;
}

class _AddAccount extends _SwitcherChoice {
  const _AddAccount();
}

/// Instagram-style account switcher: the active account, the other accounts signed in on this
/// phone, and "Add account". [current] is how the active account is listed, and how it will be
/// listed once set aside.
Future<void> showAccountSwitcher(
  BuildContext context,
  WidgetRef ref, {
  required AccountLabel current,
  required List<String> currentRoles,
}) async {
  final choice = await showModalBottomSheet<_SwitcherChoice>(
    context: context,
    showDragHandle: true,
    builder: (context) =>
        _AccountSwitcherSheet(current: current, currentRoles: currentRoles),
  );
  final auth = ref.read(authNotifierProvider.notifier);
  switch (choice) {
    case _SwitchTo(:final userId):
      await auth.switchTo(userId, current: current);
    case _AddAccount():
      await auth.addAccount(current: current);
    case null:
      break;
  }
}

class _AccountSwitcherSheet extends ConsumerWidget {
  const _AccountSwitcherSheet({
    required this.current,
    required this.currentRoles,
  });

  final AccountLabel current;
  final List<String> currentRoles;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final saved = ref.watch(savedAccountsProvider);

    return SafeArea(
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(
                AppSpacing.space24,
                0,
                AppSpacing.space24,
                AppSpacing.space8,
              ),
              child: Text(
                'shell.profile.switchAccount.title'.tr(),
                style: theme.textTheme.titleMedium,
              ),
            ),
            AccountTile(
              key: const Key('accountSwitcherCurrent'),
              label: current,
              roles: currentRoles,
              trailing: Icon(
                Icons.check_circle,
                color: colorScheme.primary,
                semanticLabel: 'shell.profile.switchAccount.current'.tr(),
              ),
            ),
            for (final account in saved)
              AccountTile(
                key: Key('accountSwitcher-${account.userId}'),
                label: account.label,
                roles: account.roles,
                onTap: () =>
                    Navigator.of(context).pop(_SwitchTo(account.userId)),
              ),
            const Divider(height: 1),
            ListTile(
              key: const Key('accountSwitcherAdd'),
              contentPadding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.space16,
                vertical: AppSpacing.space4,
              ),
              leading: CircleAvatar(
                backgroundColor: colorScheme.primaryContainer,
                foregroundColor: colorScheme.primary,
                child: const Icon(Icons.add),
              ),
              title: Text(
                'shell.profile.switchAccount.add'.tr(),
                style: theme.textTheme.titleSmall,
              ),
              subtitle: Text('shell.profile.switchAccount.subtitle'.tr()),
              onTap: () => Navigator.of(context).pop(const _AddAccount()),
            ),
            const SizedBox(height: AppSpacing.space8),
          ],
        ),
      ),
    );
  }
}
