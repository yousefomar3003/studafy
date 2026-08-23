import 'package:flutter/material.dart';

import '../../tokens/app_radius_tokens.dart';

/// Corporate Precision — card theme.
///
/// Mirrors `packages/ui/src/components/card/card.css`: definition comes from a hairline
/// border at a 12px radius, not elevation — `elevation-1` in the token spec is nearly
/// imperceptible (`0 1px 2px rgba(2,6,23,.06)`), so the border does the visual work.
abstract final class AppCardTheme {
  static CardThemeData build(ColorScheme colors) {
    return CardThemeData(
      color: colors.surface,
      surfaceTintColor: Colors.transparent,
      shadowColor: colors.shadow,
      elevation: 0,
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: AppRadius.lgRadius,
        side: BorderSide(color: colors.outline),
      ),
    );
  }
}
