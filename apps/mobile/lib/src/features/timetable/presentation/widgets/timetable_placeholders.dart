import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// A one-line, icon-led message filling a weekly schedule's body for any non-loading,
/// non-content state: unavailable, empty schedule, or errored. Kept scrollable so the screen's
/// pull-to-refresh still works while it is showing.
class TimetableMessage extends StatelessWidget {
  const TimetableMessage({required this.messageKey, required this.icon, super.key});

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

/// A static loading placeholder for a weekly schedule: a row of faux day chips over a few faux
/// lesson cards. Static, not animated, for the same reason `TodaySkeleton` is — a repeating
/// controller never lets `pumpAndSettle` settle.
class TimetableSkeleton extends StatelessWidget {
  const TimetableSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.surfaceContainerHighest;

    Widget block({double? width, required double height, BorderRadius? radius}) => SizedBox(
      width: width,
      height: height,
      child: DecoratedBox(
        decoration: BoxDecoration(color: color, borderRadius: radius ?? AppRadius.smRadius),
      ),
    );

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        Row(
          children: [
            for (var chip = 0; chip < 5; chip++) ...[
              if (chip > 0) const SizedBox(width: AppSpacing.space8),
              block(width: 52, height: 36, radius: AppRadius.fullRadius),
            ],
          ],
        ),
        const SizedBox(height: AppSpacing.space24),
        for (var card = 0; card < 3; card++) ...[
          if (card > 0) const SizedBox(height: AppSpacing.space12),
          block(height: 72, radius: AppRadius.lgRadius),
        ],
      ],
    );
  }
}
