import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// A one-line, icon-led message filling the grades screen's body for any non-loading,
/// non-content state: unavailable, errored, or an empty term. Kept scrollable so the screen's
/// pull-to-refresh still works while it is showing. Mirrors `TimetableMessage`.
class GradesMessage extends StatelessWidget {
  const GradesMessage({required this.messageKey, required this.icon, super.key});

  final String messageKey;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space24),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 20, color: colorScheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Text(
                messageKey.tr(),
                style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// A static loading placeholder for the grades screen: a summary block over a couple of faux
/// subject cards, all muted bars. Static, not animated, for the same reason `TodaySkeleton` is
/// — a repeating controller never lets `pumpAndSettle` settle.
class GradesSkeleton extends StatelessWidget {
  const GradesSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.surfaceContainerHighest;

    Widget bar(double widthFactor, double height) => FractionallySizedBox(
      alignment: AlignmentDirectional.centerStart,
      widthFactor: widthFactor,
      child: DecoratedBox(
        decoration: BoxDecoration(color: color, borderRadius: AppRadius.smRadius),
        child: SizedBox(height: height),
      ),
    );

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        bar(0.5, 18),
        const SizedBox(height: AppSpacing.space12),
        bar(0.9, 40),
        const SizedBox(height: AppSpacing.space24),
        for (var card = 0; card < 3; card++) ...[
          if (card > 0) const SizedBox(height: AppSpacing.space16),
          bar(0.45, 16),
          const SizedBox(height: AppSpacing.space8),
          bar(0.8, 14),
          const SizedBox(height: AppSpacing.space8),
          bar(0.65, 14),
        ],
      ],
    );
  }
}
