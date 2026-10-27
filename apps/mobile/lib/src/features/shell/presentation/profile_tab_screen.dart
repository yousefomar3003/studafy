import 'package:easy_localization/easy_localization.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../../../core/localization/app_locales.dart';
import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../account/presentation/notification_preferences_screen.dart';
import '../../account/presentation/signed_in_devices_screen.dart';
import '../../ai/store/ai_store_controller.dart';
import '../../student/application/student_context_providers.dart';
import '../application/shell_providers.dart';
import '../domain/app_role.dart';
import 'change_password_screen.dart';
import 'delete_account_screen.dart';
import 'delete_school_screen.dart';
import '../../../design/layout/bottom_inset_padding.dart';

/// The Profile tab, every role's shell: who is signed in, the app language, and account actions.
///
/// The header shows the role from the session's `roles` claim, plus the name and member ID(s)
/// from `GET /api/account/profile` ([accountProfileProvider]) once that loads, for every role.
///
/// The privacy policy (`/privacy`) opens in the system browser, never an in-app webview (see
/// `docs/store_payment_routing.md` for the reviewed list of outbound launches), for every role.
///
/// "Sign-in & security" ([SignInSecurityScreen]) groups changing the password, signed-in devices
/// and, for every role, "Delete my account" ([DeleteAccountScreen]), the in-app deletion App Store
/// Guideline 5.1.1(v) and Google Play require. The school admin (ORG_ADMIN) additionally gets
/// "Delete school" ([DeleteSchoolScreen]): it closes the whole school — every member is signed out
/// and can no longer sign in, and the school's data is kept. See
/// `apps/mobile/store/review-checklist.md` §1.
///
/// Log out goes through [AuthNotifier.logout]; the router's auth guard then lands on login.
class ProfileTabScreen extends ConsumerWidget {
  const ProfileTabScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final privacyPolicyUrl = ref.watch(privacyPolicyUrlProvider);
    // Opt-in only (--dart-define=SHOW_TEST_CRASH=true), so no regular build carries a crash button.
    const showTestCrash = bool.fromEnvironment('SHOW_TEST_CRASH');
    final roles = ref.watch(sessionRolesProvider);
    final appRoles = roles.map(AppRole.fromClaim).toSet();
    final isStudent = appRoles.contains(AppRole.student);
    final isSchoolAdmin = appRoles.contains(AppRole.orgAdmin);
    final profile = ref.watch(accountProfileProvider).value;
    // A student's roster name (preferred name first) wins over the account's display name.
    final student = isStudent
        ? ref.watch(currentStudentSelfProvider).value
        : null;
    final studentName = student == null
        ? null
        : '${student.preferredName ?? student.firstName} ${student.lastName}'
              .trim();
    final accountName = profile?.displayName?.trim();
    final displayName = studentName != null && studentName.isNotEmpty
        ? studentName
        : (accountName != null && accountName.isNotEmpty ? accountName : null);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(
        AppSpacing.space16,
      ).withBottomInset(context),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _ProfileHeader(
                roleLabel: profileRoleLabelKey(roles).tr(),
                displayName: displayName,
                memberIds: profile?.memberIds ?? const [],
              ),
              const SizedBox(height: AppSpacing.space24),
              _SectionLabel('shell.profile.sections.preferences'.tr()),
              const Card(
                margin: EdgeInsets.zero,
                child: Padding(
                  padding: EdgeInsets.all(AppSpacing.space16),
                  child: _LanguageSetting(),
                ),
              ),
              const SizedBox(height: AppSpacing.space24),
              _SectionLabel('shell.profile.sections.account'.tr()),
              Card(
                margin: EdgeInsets.zero,
                clipBehavior: Clip.antiAlias,
                child: Column(
                  children: [
                    _SettingsRow(
                      key: const Key('profileSignInSecurity'),
                      icon: Icons.shield_outlined,
                      titleKey: 'shell.profile.signInSecurity.title',
                      trailing: Icons.chevron_right,
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => const SignInSecurityScreen(),
                        ),
                      ),
                    ),
                    const Divider(height: 1, indent: 68),
                    _SettingsRow(
                      key: const Key('profileNotifications'),
                      icon: Icons.notifications_none_outlined,
                      titleKey: 'account.notifications.title',
                      trailing: Icons.chevron_right,
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => const NotificationPreferencesScreen(),
                        ),
                      ),
                    ),
                    if (isStudent) const _RestorePurchasesTile(),
                    const Divider(height: 1, indent: 68),
                    _SettingsRow(
                      key: const Key('profilePrivacyPolicy'),
                      icon: Icons.privacy_tip_outlined,
                      titleKey: 'shell.profile.privacyPolicy',
                      trailing: Icons.open_in_new,
                      onTap: () => launchUrl(
                        privacyPolicyUrl,
                        mode: LaunchMode.externalApplication,
                      ),
                    ),
                    if (isSchoolAdmin) ...[
                      const Divider(height: 1, indent: 68),
                      const _DeleteSchoolTile(),
                    ],
                    // Opt-in builds only: forces a native crash so Crashlytics receives a first
                    // report. It is sent on the next launch, not at the moment of the crash.
                    if (showTestCrash) ...[
                      const Divider(height: 1, indent: 68),
                      _SettingsRow(
                        key: const Key('profileTestCrash'),
                        icon: Icons.bug_report_outlined,
                        titleKey: 'shell.profile.testCrash',
                        trailing: Icons.chevron_right,
                        destructive: true,
                        onTap: () => FirebaseCrashlytics.instance.crash(),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.space24),
              const Card(
                margin: EdgeInsets.zero,
                clipBehavior: Clip.antiAlias,
                child: _LogoutButton(),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Translation key for the label of the session's most significant role, by [AppRole]'s
/// declaration order (admin types first). Unrecognised or missing claims read as "Member".
String profileRoleLabelKey(List<String> roleClaims) {
  final roles = roleClaims.map(AppRole.fromClaim).whereType<AppRole>().toSet();
  for (final role in AppRole.values) {
    if (roles.contains(role)) return 'shell.profile.roles.${role.name}';
  }
  return 'shell.profile.roles.unknown';
}

class _ProfileHeader extends StatelessWidget {
  const _ProfileHeader({
    required this.roleLabel,
    this.displayName,
    this.memberIds = const [],
  });

  final String roleLabel;

  /// The person's name when known; otherwise the header leads with [roleLabel] alone.
  final String? displayName;

  /// The member IDs the person signs in with, shown under the name; empty hides the line.
  final List<String> memberIds;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final name = displayName;
    final initial = _initials(name ?? roleLabel);

    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: Stack(
        children: [
          // A tinted band behind the top half of the avatar gives the header some depth.
          PositionedDirectional(
            start: 0,
            end: 0,
            top: 0,
            height: 64,
            child: ColoredBox(color: colorScheme.primaryContainer),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.space20,
              AppSpacing.space24,
              AppSpacing.space20,
              AppSpacing.space24,
            ),
            child: Column(
              children: [
                ExcludeSemantics(
                  child: Container(
                    padding: const EdgeInsets.all(AppSpacing.space4),
                    decoration: BoxDecoration(
                      color: colorScheme.surface,
                      shape: BoxShape.circle,
                    ),
                    child: CircleAvatar(
                      radius: 40,
                      backgroundColor: colorScheme.primary,
                      foregroundColor: colorScheme.onPrimary,
                      child: Text(
                        initial.toUpperCase(),
                        style: theme.textTheme.headlineSmall?.copyWith(
                          color: colorScheme.onPrimary,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: AppSpacing.space12),
                if (name != null) ...[
                  Text(
                    name,
                    key: const Key('profileName'),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space8),
                ],
                if (memberIds.isNotEmpty) ...[
                  SelectableText(
                    memberIds.join(' · '),
                    key: const Key('profileMemberId'),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colorScheme.onSurfaceVariant,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space8),
                ],
                DecoratedBox(
                  decoration: BoxDecoration(
                    color: colorScheme.primaryContainer,
                    borderRadius: AppRadius.fullRadius,
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.space12,
                      vertical: AppSpacing.space4,
                    ),
                    child: Text(
                      roleLabel,
                      key: const Key('profileRole'),
                      style: theme.textTheme.labelLarge?.copyWith(
                        color: colorScheme.onPrimaryContainer,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: AppSpacing.space12),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      Icons.verified_user_outlined,
                      size: 16,
                      color: colorScheme.tertiary,
                    ),
                    const SizedBox(width: AppSpacing.space4),
                    Text(
                      'shell.profile.signedIn'.tr(),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The rounded-square icon badge that leads each settings row, matching the home cards' headers.
class _IconTile extends StatelessWidget {
  const _IconTile(this.icon, {this.destructive = false});

  final IconData icon;
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Container(
      width: 36,
      height: 36,
      decoration: BoxDecoration(
        color: destructive
            ? colorScheme.errorContainer
            : colorScheme.primaryContainer,
        borderRadius: AppRadius.mdRadius,
      ),
      child: Icon(
        icon,
        size: 20,
        color: destructive ? colorScheme.error : colorScheme.primary,
      ),
    );
  }
}

/// One tappable row in a settings card: icon tile, title, trailing affordance.
class _SettingsRow extends StatelessWidget {
  const _SettingsRow({
    required this.icon,
    required this.titleKey,
    required this.trailing,
    required this.onTap,
    this.destructive = false,
    super.key,
  });

  final IconData icon;

  /// Translated here rather than by the caller: this build depends on [Theme], which updates
  /// once a newly selected locale's translations finish loading, so the label re-resolves even
  /// when the calling widget is `const` and never rebuilds.
  final String titleKey;
  final IconData trailing;
  final VoidCallback onTap;
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.space16,
        vertical: AppSpacing.space4,
      ),
      leading: _IconTile(icon, destructive: destructive),
      title: Text(
        titleKey.tr(),
        style: theme.textTheme.titleSmall?.copyWith(
          color: destructive ? colorScheme.error : colorScheme.onSurface,
        ),
      ),
      trailing: Icon(
        trailing,
        size: 20,
        color: destructive ? colorScheme.error : colorScheme.onSurfaceVariant,
      ),
      onTap: onTap,
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsetsDirectional.only(
        start: AppSpacing.space4,
        bottom: AppSpacing.space8,
      ),
      child: Semantics(
        header: true,
        child: Text(
          text,
          style: theme.textTheme.labelLarge?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

/// English / العربية switch. Applies instantly; `easy_localization` persists the choice
/// (`saveLocale`, on by default) so it survives restarts.
class _LanguageSetting extends StatelessWidget {
  const _LanguageSetting();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            const _IconTile(Icons.translate),
            const SizedBox(width: AppSpacing.space16),
            Text(
              'shell.profile.language'.tr(),
              style: theme.textTheme.titleSmall,
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.space12),
        SegmentedButton<Locale>(
          key: const Key('profileLanguageSelector'),
          showSelectedIcon: false,
          segments: [
            for (final locale in AppLocales.supported)
              ButtonSegment(
                value: locale,
                label: Text(
                  AppLocales.nativeNames[locale] ?? locale.languageCode,
                  key: Key('profileLanguage_${locale.languageCode}'),
                ),
              ),
          ],
          selected: {context.locale},
          onSelectionChanged: (selection) => context.setLocale(selection.first),
        ),
      ],
    );
  }
}

/// Sign-in & security, opened from the Profile tab's Account card: the member's password (for
/// member-password accounts), the devices signed in to this account, and "Delete my account".
class SignInSecurityScreen extends ConsumerWidget {
  const SignInSecurityScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roles = ref.watch(sessionRolesProvider);

    return Scaffold(
      appBar: AppBar(title: Text('shell.profile.signInSecurity.title'.tr())),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.space16).withBottomInset(context),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Card(
              margin: EdgeInsets.zero,
              clipBehavior: Clip.antiAlias,
              child: Column(
                children: [
                  if (canChangeMemberPassword(roles)) ...[
                    _SettingsRow(
                      key: const Key('profileChangePassword'),
                      icon: Icons.lock_outline,
                      titleKey: 'shell.profile.changePassword.title',
                      trailing: Icons.chevron_right,
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => const ChangePasswordScreen(),
                        ),
                      ),
                    ),
                    const Divider(height: 1, indent: 68),
                  ],
                  _SettingsRow(
                    key: const Key('profileSignedInDevices'),
                    icon: Icons.devices_outlined,
                    titleKey: 'account.devices.title',
                    trailing: Icons.chevron_right,
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const SignedInDevicesScreen(),
                      ),
                    ),
                  ),
                  const Divider(height: 1, indent: 68),
                  const _DeleteAccountTile(),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Every role's "Delete my account" entry point, inside [SignInSecurityScreen].
class _DeleteAccountTile extends StatelessWidget {
  const _DeleteAccountTile();

  @override
  Widget build(BuildContext context) {
    return _SettingsRow(
      key: const Key('profileDeleteAccount'),
      icon: Icons.person_remove_outlined,
      titleKey: 'shell.profile.deleteAccount.action',
      trailing: Icons.chevron_right,
      destructive: true,
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          fullscreenDialog: true,
          builder: (_) => const DeleteAccountScreen(),
        ),
      ),
    );
  }
}

/// The student's "Restore purchases": asks the store to redeliver a previous AI add-on purchase.
/// Shown only while the add-on is on offer to this student on this device (the same condition as
/// the AI tab's offer card, which carries the same action) — otherwise there is nothing to restore.
class _RestorePurchasesTile extends ConsumerWidget {
  const _RestorePurchasesTile();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(aiStoreProvider, (previous, next) {
      final message = switch (next.value) {
        AiStoreActivated() => 'account.restore.done',
        AiStoreOffering(:final messageKey?) => messageKey,
        _ => null,
      };
      if (message == null || previous?.value == next.value) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(message.tr())));
    });
    final offer = ref.watch(aiStoreProvider).value;
    if (offer is! AiStoreOffering) return const SizedBox.shrink();

    return Column(
      children: [
        const Divider(height: 1, indent: 68),
        _SettingsRow(
          key: const Key('profileRestorePurchases'),
          icon: Icons.restore,
          titleKey: 'aiStore.restore.action',
          trailing: Icons.chevron_right,
          onTap: offer.busy == AiStoreBusy.none
              ? () => ref.read(aiStoreProvider.notifier).restore()
              : () {},
        ),
      ],
    );
  }
}

/// The school admin's "Delete school" entry point, styled as the destructive action it is.
class _DeleteSchoolTile extends StatelessWidget {
  const _DeleteSchoolTile();

  @override
  Widget build(BuildContext context) {
    return _SettingsRow(
      key: const Key('profileDeleteSchool'),
      icon: Icons.domain_disabled_outlined,
      titleKey: 'shell.profile.deleteSchool.action',
      trailing: Icons.chevron_right,
      destructive: true,
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          fullscreenDialog: true,
          builder: (_) => const DeleteSchoolScreen(),
        ),
      ),
    );
  }
}

class _LogoutButton extends ConsumerWidget {
  const _LogoutButton();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _SettingsRow(
      key: const Key('profileLogout'),
      icon: Icons.logout,
      titleKey: 'shell.profile.logout',
      trailing: Icons.chevron_right,
      destructive: true,
      onTap: () async {
        final confirmed = await showDialog<bool>(
          context: context,
          builder: (context) => const _LogoutDialog(),
        );
        if (confirmed ?? false) {
          await ref.read(authNotifierProvider.notifier).logout();
        }
      },
    );
  }
}

class _LogoutDialog extends StatelessWidget {
  const _LogoutDialog();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return AlertDialog(
      title: Text('shell.profile.logoutDialog.title'.tr()),
      content: Text('shell.profile.logoutDialog.body'.tr()),
      actions: [
        TextButton(
          key: const Key('logoutCancel'),
          onPressed: () => Navigator.of(context).pop(false),
          child: Text('shell.profile.logoutDialog.cancel'.tr()),
        ),
        FilledButton(
          key: const Key('logoutConfirm'),
          style: FilledButton.styleFrom(
            backgroundColor: colorScheme.error,
            foregroundColor: colorScheme.onError,
          ),
          onPressed: () => Navigator.of(context).pop(true),
          child: Text('shell.profile.logoutDialog.confirm'.tr()),
        ),
      ],
    );
  }
}

/// Up to two initials ("Adam Fares" → "AF"); a single word gives its first letter.
String _initials(String text) {
  final words = text
      .trim()
      .split(RegExp(r'\s+'))
      .where((w) => w.isNotEmpty)
      .toList();
  if (words.isEmpty) return '';
  final first = words.first.characters.first;
  final last = words.length > 1 ? words.last.characters.first : '';
  return (first + last).toUpperCase();
}
