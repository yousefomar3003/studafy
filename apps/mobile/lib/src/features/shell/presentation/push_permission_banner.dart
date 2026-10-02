import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/push/push_providers.dart';
import '../../../design/tokens/app_spacing_tokens.dart';

/// Explains what notifications are for, then continues to the OS permission prompt.
///
/// Shown at the top of the shell only while that prompt is unanswered
/// ([PushSetup.needsPermission]). It has a single "Continue" action and no "Not now": App Review
/// rejects a pre-permission message that lets the user back out before the system prompt (5.1.1).
/// The user can still refuse in the OS prompt itself, and can leave this banner untapped.
class PushPermissionBanner extends ConsumerWidget {
  const PushPermissionBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;

    return ColoredBox(
      color: colors.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space16,
          vertical: AppSpacing.space12,
        ),
        child: Row(
          children: [
            Icon(
              Icons.notifications_outlined,
              size: 20,
              color: colors.onSecondaryContainer,
            ),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Text(
                'shell.pushPermission.body'.tr(),
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.onSecondaryContainer,
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.space8),
            TextButton(
              onPressed: () => ref.read(pushSetupProvider.notifier).requestPermission(),
              child: Text('shell.pushPermission.continue'.tr()),
            ),
          ],
        ),
      ),
    );
  }
}
