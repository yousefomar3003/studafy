import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// The "publish moment": a dismissible banner the grades screen shows when it was opened from a
/// grade-posted push, so arriving from the notification feels like an occasion without being
/// noisy about it. Celebratory comes from the copy and the primary-container fill and the
/// sparkle icon — not from motion or colour outside the theme.
class GradesPublishBanner extends StatelessWidget {
  const GradesPublishBanner({required this.onDismiss, super.key});

  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return Container(
      decoration: BoxDecoration(
        color: colorScheme.primaryContainer,
        borderRadius: AppRadius.lgRadius,
      ),
      padding: const EdgeInsets.all(AppSpacing.space16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.auto_awesome, size: 20, color: colorScheme.onPrimaryContainer),
          const SizedBox(width: AppSpacing.space12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'grades.publishMoment.title'.tr(),
                  style: textTheme.titleSmall?.copyWith(color: colorScheme.onPrimaryContainer),
                ),
                const SizedBox(height: AppSpacing.space4),
                Text(
                  'grades.publishMoment.body'.tr(),
                  style: textTheme.bodySmall?.copyWith(color: colorScheme.onPrimaryContainer),
                ),
              ],
            ),
          ),
          IconButton(
            onPressed: onDismiss,
            icon: const Icon(Icons.close),
            iconSize: 18,
            visualDensity: VisualDensity.compact,
            tooltip: 'grades.publishMoment.dismiss'.tr(),
            color: colorScheme.onPrimaryContainer,
          ),
        ],
      ),
    );
  }
}
