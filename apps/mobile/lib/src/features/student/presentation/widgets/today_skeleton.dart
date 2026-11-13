import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// A static loading placeholder for a today-screen card body: [lineCount] muted bars of
/// decreasing width, standing in for the rows a loaded card would show.
///
/// Deliberately not animated (no shimmer sweep): a repeating [AnimationController] never
/// settles, and every screen in this app that has one is captured with `pumpAndSettle` — a
/// shimmering skeleton would either hang that call or force every golden and widget test that
/// touches this screen to use timed pumps instead. A static placeholder communicates "loading"
/// just as well without that cost.
class TodaySkeleton extends StatelessWidget {
  const TodaySkeleton({this.lineCount = 3, super.key});

  final int lineCount;

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.surfaceContainerHighest;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < lineCount; i++) ...[
          if (i > 0) const SizedBox(height: AppSpacing.space8),
          FractionallySizedBox(
            alignment: Alignment.centerLeft,
            widthFactor: i.isEven ? 0.85 : 0.55,
            child: DecoratedBox(
              decoration: BoxDecoration(color: color, borderRadius: AppRadius.smRadius),
              child: const SizedBox(height: 14),
            ),
          ),
        ],
      ],
    );
  }
}
