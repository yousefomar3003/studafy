import 'package:flutter/material.dart';

import '../tokens/app_color_tokens.dart';

/// Corporate Precision — semantic colors with no home in Material's [ColorScheme].
///
/// Every other semantic alias from `packages/ui/src/theme.ts` (background, surface, border,
/// muted-foreground, accent/success/danger "subtle" pairs, ...) already has a direct
/// [ColorScheme] counterpart — see the mapping table in `../README.md`. `warning` is the one
/// role Material's scheme has no slot for, so it lives here instead of duplicating the rest
/// of [ColorScheme] a second time.
@immutable
class AppSemanticColors extends ThemeExtension<AppSemanticColors> {
  const AppSemanticColors({
    required this.warning,
    required this.onWarning,
    required this.warningContainer,
    required this.onWarningContainer,
  });

  factory AppSemanticColors.light() => const AppSemanticColors(
    warning: AppColorTokens.warning700,
    onWarning: AppColorTokens.white,
    warningContainer: AppColorTokens.warning100,
    onWarningContainer: AppColorTokens.warning800,
  );

  factory AppSemanticColors.dark() => const AppSemanticColors(
    warning: AppColorTokens.warning400,
    onWarning: AppColorTokens.neutral950,
    warningContainer: AppColorTokens.neutral900,
    onWarningContainer: AppColorTokens.warning400,
  );

  final Color warning;
  final Color onWarning;
  final Color warningContainer;
  final Color onWarningContainer;

  @override
  AppSemanticColors copyWith({
    Color? warning,
    Color? onWarning,
    Color? warningContainer,
    Color? onWarningContainer,
  }) {
    return AppSemanticColors(
      warning: warning ?? this.warning,
      onWarning: onWarning ?? this.onWarning,
      warningContainer: warningContainer ?? this.warningContainer,
      onWarningContainer: onWarningContainer ?? this.onWarningContainer,
    );
  }

  @override
  AppSemanticColors lerp(ThemeExtension<AppSemanticColors>? other, double t) {
    if (other is! AppSemanticColors) {
      return this;
    }
    return AppSemanticColors(
      warning: Color.lerp(warning, other.warning, t)!,
      onWarning: Color.lerp(onWarning, other.onWarning, t)!,
      warningContainer: Color.lerp(warningContainer, other.warningContainer, t)!,
      onWarningContainer: Color.lerp(onWarningContainer, other.onWarningContainer, t)!,
    );
  }
}
