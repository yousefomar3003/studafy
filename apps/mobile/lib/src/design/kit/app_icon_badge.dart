import 'package:flutter/material.dart';

import '../tokens/app_accent_tokens.dart';
import 'app_tone.dart';

/// A rounded square in an accent's soft tint holding an icon (or a short label such as a period
/// number) in the accent's strong colour: the coloured lead-in of every kit row and header.
///
/// [filled] swaps to the solid fill with light-on-dark contents, for the one item that should
/// stand out (e.g. the current period).
class AppIconBadge extends StatelessWidget {
  const AppIconBadge({
    this.icon,
    this.label,
    this.accent = AppAccent.blue,
    this.size = 40,
    this.filled = false,
    super.key,
  }) : assert(
         icon != null || label != null,
         'Give the badge an icon or a label.',
       );

  final IconData? icon;

  /// Short text shown instead of [icon] ("1", "P3"); scaled down to fit.
  final String? label;
  final AppAccent accent;
  final double size;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    final colors = accent.colorsOf(context);
    final background = filled ? colors.solid : colors.container;
    final foreground = filled ? colors.onSolid : colors.onContainer;

    return SizedBox.square(
      dimension: size,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(size * 0.3),
        ),
        child: Center(
          child: label != null
              ? Padding(
                  padding: EdgeInsets.all(size * 0.12),
                  child: FittedBox(
                    child: Text(
                      label!,
                      maxLines: 1,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        color: foreground,
                        fontWeight: FontWeight.w700,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                  ),
                )
              : Icon(icon, size: size * 0.5, color: foreground),
        ),
      ),
    );
  }
}
