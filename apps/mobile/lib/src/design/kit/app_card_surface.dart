import 'package:flutter/material.dart';

import '../tokens/app_radius_tokens.dart';

/// The kit's card: the themed [Card] (hairline border, 16px radius) lifted by a soft, wide shadow
/// so it reads as a raised panel on the page tint rather than a box drawn on it. In dark mode the
/// shadow is invisible against the near-black page and the border does the work alone.
class AppCardSurface extends StatelessWidget {
  const AppCardSurface({required this.child, this.color, super.key});

  final Widget child;

  /// Overrides the card colour (e.g. a tinted call-to-action card).
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;

    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: AppRadius.xlRadius,
        boxShadow: [
          BoxShadow(
            color: colors.shadow.withValues(alpha: 0.05),
            blurRadius: 16,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: Card(color: color, child: child),
    );
  }
}
