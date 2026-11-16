import 'package:flutter/material.dart';

import '../tokens/app_accent_tokens.dart';

/// The meaning a kit component's colour carries: the brand, a neutral fact, or a status.
///
/// Each tone is one [AppAccent] hue, so tones and subject accents share one contrast-checked
/// palette and match in visual weight.
enum AppTone {
  neutral(AppAccent.slate),
  brand(AppAccent.blue),
  info(AppAccent.violet),
  success(AppAccent.green),
  warning(AppAccent.amber),
  danger(AppAccent.red);

  const AppTone(this.accent);

  final AppAccent accent;

  /// This tone's colours for the ambient theme's brightness.
  AppAccentColors colorsOf(BuildContext context) => accent.colorsOf(context);

  /// The tint for a mark or rate: [success] from 85%, [brand] from 70%, [warning] from 50%,
  /// [danger] below, [neutral] when there is none. Whatever shows it still prints the number, so
  /// the colour only reinforces it.
  static AppTone forPercentage(num? percentage) {
    if (percentage == null) return AppTone.neutral;
    if (percentage >= 85) return AppTone.success;
    if (percentage >= 70) return AppTone.brand;
    if (percentage >= 50) return AppTone.warning;
    return AppTone.danger;
  }
}

extension AppAccentContext on AppAccent {
  /// This accent's colours for the ambient theme's brightness (the theme's, not the platform's:
  /// the app can be forced light or dark).
  AppAccentColors colorsOf(BuildContext context) =>
      resolve(Theme.of(context).brightness);
}
