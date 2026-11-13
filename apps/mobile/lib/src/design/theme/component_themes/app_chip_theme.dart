import 'package:flutter/material.dart';

import '../../tokens/app_spacing_tokens.dart';
import '../../tokens/app_typography_tokens.dart';

/// Corporate Precision — chip theme.
///
/// Mirrors `packages/ui/src/components/chip/chip.css`'s "filled" variant (a full-radius pill
/// on the accent-subtle pair): [ChipThemeData] has one shared style, not per-variant styles,
/// so the CSS "outlined" variant is a per-instance override (`side:`, `backgroundColor:
/// Colors.transparent`) rather than a second theme.
abstract final class AppChipTheme {
  static ChipThemeData build(ColorScheme colors, TextTheme textTheme) {
    return ChipThemeData(
      shape: const StadiumBorder(),
      side: BorderSide.none,
      backgroundColor: colors.primaryContainer,
      disabledColor: colors.onSurface.withValues(alpha: 0.12),
      selectedColor: colors.primaryContainer,
      labelStyle: (textTheme.labelSmall ?? const TextStyle()).copyWith(
        color: colors.onPrimaryContainer,
        height: AppLineHeight.sm / AppFontSize.xs,
      ),
      labelPadding: EdgeInsets.zero,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.space12,
        vertical: AppSpacing.space4,
      ),
      iconTheme: IconThemeData(color: colors.onPrimaryContainer, size: AppSpacing.space16),
    );
  }
}
