import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/theme/app_semantic_colors.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/ai_usage.dart';

/// The usage screen's heads-up for [AiUsageLevel.nearingLimit] and [AiUsageLevel.exhausted] --
/// collapses to nothing at [AiUsageLevel.normal], the common case. Two tones: nearing-limit
/// borrows the app's [AppSemanticColors.warningContainer] (a generation would still succeed);
/// exhausted borrows [ColorScheme.errorContainer], the same tone `ExamCreateError` and friends use
/// for an actual `AI_QUOTA_EXCEEDED` refusal, since that is exactly what happens next here.
class AiUsageWarningBanner extends StatelessWidget {
  const AiUsageWarningBanner({required this.level, super.key});

  final AiUsageLevel level;

  @override
  Widget build(BuildContext context) {
    if (level == AiUsageLevel.normal) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final semanticColors = theme.extension<AppSemanticColors>()!;
    final exhausted = level == AiUsageLevel.exhausted;
    final background = exhausted ? colorScheme.errorContainer : semanticColors.warningContainer;
    final foreground = exhausted
        ? colorScheme.onErrorContainer
        : semanticColors.onWarningContainer;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.space12),
      decoration: BoxDecoration(color: background, borderRadius: AppRadius.mdRadius),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            exhausted ? Icons.block_outlined : Icons.warning_amber_outlined,
            size: 20,
            color: foreground,
          ),
          const SizedBox(width: AppSpacing.space8),
          Expanded(
            child: Text(
              (exhausted ? 'ai.usage.warning.exhausted' : 'ai.usage.warning.nearingLimit').tr(),
              style: theme.textTheme.bodyMedium?.copyWith(color: foreground),
            ),
          ),
        ],
      ),
    );
  }
}
