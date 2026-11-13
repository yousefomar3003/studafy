import 'package:flutter/material.dart';

import '../../tokens/app_radius_tokens.dart';
import '../../tokens/app_spacing_tokens.dart';

/// Corporate Precision — text field theme.
///
/// Mirrors `packages/ui/src/components/input/input.css`: an outlined 8px-radius field with a
/// 2px accent-colored focus ring and a danger-colored error border.
abstract final class AppInputTheme {
  static InputDecorationTheme build(ColorScheme colors) {
    OutlineInputBorder border(Color color, {double width = 1}) {
      return OutlineInputBorder(
        borderRadius: AppRadius.mdRadius,
        borderSide: BorderSide(color: color, width: width),
      );
    }

    return InputDecorationTheme(
      filled: true,
      fillColor: colors.surface,
      contentPadding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.space12,
        vertical: AppSpacing.space8,
      ),
      hintStyle: TextStyle(color: colors.onSurfaceVariant),
      labelStyle: TextStyle(color: colors.onSurfaceVariant),
      border: border(colors.outline),
      enabledBorder: border(colors.outline),
      focusedBorder: border(colors.primary, width: 2),
      errorBorder: border(colors.error),
      focusedErrorBorder: border(colors.error, width: 2),
      disabledBorder: border(colors.onSurface.withValues(alpha: 0.12)),
    ).copyWith(
      // Disabled fields sit on the tonal surface, same as `.sf-input:has(:disabled)`.
      fillColor: WidgetStateColor.resolveWith((states) {
        if (states.contains(WidgetState.disabled)) {
          return colors.surfaceContainerHighest;
        }
        return colors.surface;
      }),
    );
  }
}
