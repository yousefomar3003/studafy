import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/di/app_providers.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/shell_providers.dart';

/// The Profile tab, every role's shell. Still a placeholder for profile content itself (no
/// account/profile feature has shipped yet), but carries two real actions: requesting account
/// deletion at `/account/delete` and reading the privacy policy at `/privacy`. Both open in the
/// system browser, never an in-app webview (see `docs/store_payment_routing.md` for the reviewed
/// list of outbound launches).
///
/// Before this, the app had no account-deletion path anywhere — see
/// `apps/mobile/store/review-checklist.md`'s blocking item on this. `/account/delete` requires a
/// web sign-in of its own (the web session is independent of this app's token, same as the AI
/// checkout page already requires), so this hands off to that rather than reimplementing account
/// deletion as a second, separate flow.
class ProfileTabScreen extends ConsumerWidget {
  const ProfileTabScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final deleteUrl = ref.watch(accountDeleteUrlProvider);
    final privacyPolicyUrl = ref.watch(privacyPolicyUrlProvider);

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('shell.tabs.profile'.tr(), style: textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text(
              'shell.placeholderBody'.tr(),
              style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AppSpacing.space24),
            OutlinedButton.icon(
              onPressed: () => launchUrl(deleteUrl, mode: LaunchMode.externalApplication),
              icon: const Icon(Icons.open_in_new),
              label: Text('shell.profile.deleteAccount'.tr()),
            ),
            TextButton(
              onPressed: () => launchUrl(privacyPolicyUrl, mode: LaunchMode.externalApplication),
              child: Text('shell.profile.privacyPolicy'.tr()),
            ),
          ],
        ),
      ),
    );
  }
}
