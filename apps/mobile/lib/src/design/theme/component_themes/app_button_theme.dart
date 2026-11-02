import 'package:flutter/material.dart';

import '../../tokens/app_radius_tokens.dart';
import '../../tokens/app_spacing_tokens.dart';

/// Corporate Precision — button component themes.
///
/// Mirrors `packages/ui/src/components/button/button.css`'s three variants onto Material3's
/// own three button widgets, which already carry the same visual intent:
/// primary → [FilledButton], secondary → [OutlinedButton], tertiary → [TextButton].
abstract final class AppButtonTheme {
  static const _shape = RoundedRectangleBorder(borderRadius: AppRadius.mdRadius);
  static const _padding = EdgeInsets.symmetric(
    horizontal: AppSpacing.space16,
    vertical: AppSpacing.space8,
  );

  static FilledButtonThemeData filled(ColorScheme colors) {
    return FilledButtonThemeData(
      style: ButtonStyle(
        shape: const WidgetStatePropertyAll(_shape),
        padding: const WidgetStatePropertyAll(_padding),
        minimumSize: const WidgetStatePropertyAll(Size(64, 40)),
        backgroundColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.disabled)) {
            return colors.onSurface.withValues(alpha: 0.12);
          }
          if (states.contains(WidgetState.pressed)) {
            return Color.alphaBlend(colors.shadow.withValues(alpha: 0.16), colors.primary);
          }
          if (states.contains(WidgetState.hovered)) {
            return Color.alphaBlend(colors.shadow.withValues(alpha: 0.08), colors.primary);
          }
          return colors.primary;
        }),
        foregroundColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.disabled)) {
            return colors.onSurface.withValues(alpha: 0.38);
          }
          return colors.onPrimary;
        }),
      ),
    );
  }

  static OutlinedButtonThemeData outlined(ColorScheme colors) {
    return OutlinedButtonThemeData(
      style: ButtonStyle(
        shape: const WidgetStatePropertyAll(_shape),
        padding: const WidgetStatePropertyAll(_padding),
        minimumSize: const WidgetStatePropertyAll(Size(64, 40)),
        side: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.disabled)) {
            return BorderSide(color: colors.onSurface.withValues(alpha: 0.12));
          }
          return BorderSide(color: colors.outline);
        }),
        backgroundColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.pressed)) {
            return colors.primaryContainer;
          }
          if (states.contains(WidgetState.hovered)) {
            return colors.surfaceContainerHighest;
          }
          return colors.surface;
        }),
        foregroundColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.disabled)) {
            return colors.onSurface.withValues(alpha: 0.38);
          }
          return colors.onSurface;
        }),
      ),
    );
  }

  static TextButtonThemeData text(ColorScheme colors) {
    return TextButtonThemeData(
      style: ButtonStyle(
        shape: const WidgetStatePropertyAll(_shape),
        padding: const WidgetStatePropertyAll(_padding),
        minimumSize: const WidgetStatePropertyAll(Size(64, 40)),
        backgroundColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.pressed) || states.contains(WidgetState.hovered)) {
            return colors.primaryContainer;
          }
          return Colors.transparent;
        }),
        foregroundColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.disabled)) {
            return colors.onSurface.withValues(alpha: 0.38);
          }
          if (states.contains(WidgetState.pressed)) {
            return colors.onPrimaryContainer;
          }
          return colors.primary;
        }),
      ),
    );
  }
}
