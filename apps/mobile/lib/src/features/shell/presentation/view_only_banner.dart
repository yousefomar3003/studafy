import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../design/theme/app_semantic_colors.dart';
import '../../../design/tokens/app_spacing_tokens.dart';

/// Shown at the top of [ShellRole.viewer]'s shell: the account this session belongs to has no
/// mutation affordances on mobile.
class ViewOnlyBanner extends StatelessWidget {
  const ViewOnlyBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final semanticColors = theme.extension<AppSemanticColors>()!;

    return ColoredBox(
      color: semanticColors.warningContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space16,
          vertical: AppSpacing.space12,
        ),
        child: Row(
          children: [
            Icon(
              Icons.visibility_outlined,
              size: 20,
              color: semanticColors.onWarningContainer,
            ),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Text(
                'shell.viewOnlyBanner'.tr(),
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: semanticColors.onWarningContainer,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
