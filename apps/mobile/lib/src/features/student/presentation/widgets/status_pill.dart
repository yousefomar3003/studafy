import 'package:flutter/material.dart';

import '../../../../design/theme/app_semantic_colors.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// The visual weight of a [StatusPill] — which [ColorScheme]/[AppSemanticColors] pair it draws
/// from, not a fixed color, so it stays correct across light/dark and the two locales.
enum StatusPillTone { neutral, warning, danger, success }

/// A small filled, fully-rounded label for one assignment or submission state — "Late",
/// "Graded", "92/100" — used on both the assignment list rows and the detail screen.
class StatusPill extends StatelessWidget {
  const StatusPill({required this.label, required this.tone, super.key});

  final String label;
  final StatusPillTone tone;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final semanticColors = Theme.of(context).extension<AppSemanticColors>()!;
    final (background, foreground) = switch (tone) {
      StatusPillTone.neutral => (colorScheme.surfaceContainerHighest, colorScheme.onSurfaceVariant),
      StatusPillTone.warning => (
        semanticColors.warningContainer,
        semanticColors.onWarningContainer,
      ),
      StatusPillTone.danger => (colorScheme.errorContainer, colorScheme.onErrorContainer),
      StatusPillTone.success => (colorScheme.primaryContainer, colorScheme.onPrimaryContainer),
    };

    return DecoratedBox(
      decoration: BoxDecoration(color: background, borderRadius: AppRadius.fullRadius),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space8,
          vertical: AppSpacing.space4,
        ),
        child: Text(
          label,
          style: Theme.of(
            context,
          ).textTheme.labelSmall?.copyWith(color: foreground, fontWeight: FontWeight.w600),
        ),
      ),
    );
  }
}
