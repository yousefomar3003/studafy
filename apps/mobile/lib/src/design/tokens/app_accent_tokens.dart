import 'dart:ui' show Brightness;

import 'package:flutter/foundation.dart' show immutable;
import 'package:flutter/painting.dart';

import 'app_color_tokens.dart';

/// One accent hue's four roles in one brightness: a [solid] fill with [onSolid] text on it, and a
/// soft [container] tint with [onContainer] text and icons on it.
///
/// Every pair clears WCAG AA (4.5:1) for normal-size text; `test/design/kit/app_accent_test.dart`
/// checks each one, in both brightnesses, so a later edit can't quietly break contrast.
@immutable
class AppAccentColors {
  const AppAccentColors({
    required this.solid,
    required this.onSolid,
    required this.container,
    required this.onContainer,
  });

  final Color solid;
  final Color onSolid;
  final Color container;
  final Color onContainer;
}

/// The colour-coding palette: a set of hues, each tuned for light and dark, that the visual kit
/// (`design/kit/`) uses to give subjects, classes and section icons a consistent accent.
///
/// The hues follow the same Tailwind-derived scale as [AppColorTokens] (the brand blue is
/// `accent600`, the neutrals are slate), so accents sit naturally next to the brand colours: the
/// 100 step as the light container under 800 text, the 600/700 step (whichever holds 4.5:1
/// against white) as the light solid, and in dark the 950 step as the container under 200 text,
/// with the 400 step as the solid under near-black text.
enum AppAccent {
  blue(
    light: AppAccentColors(
      solid: AppColorTokens.accent600,
      onSolid: AppColorTokens.white,
      container: AppColorTokens.accent100,
      onContainer: AppColorTokens.accent800,
    ),
    dark: AppAccentColors(
      solid: AppColorTokens.accent400,
      onSolid: AppColorTokens.neutral950,
      container: AppColorTokens.accent950,
      onContainer: AppColorTokens.accent200,
    ),
  ),
  indigo(
    light: AppAccentColors(
      solid: Color(0xFF4F46E5),
      onSolid: AppColorTokens.white,
      container: Color(0xFFE0E7FF),
      onContainer: Color(0xFF3730A3),
    ),
    dark: AppAccentColors(
      solid: Color(0xFF818CF8),
      onSolid: AppColorTokens.neutral950,
      container: Color(0xFF1E1B4B),
      onContainer: Color(0xFFC7D2FE),
    ),
  ),
  violet(
    light: AppAccentColors(
      solid: Color(0xFF7C3AED),
      onSolid: AppColorTokens.white,
      container: Color(0xFFEDE9FE),
      onContainer: Color(0xFF5B21B6),
    ),
    dark: AppAccentColors(
      solid: Color(0xFFA78BFA),
      onSolid: AppColorTokens.neutral950,
      container: Color(0xFF2E1065),
      onContainer: Color(0xFFDDD6FE),
    ),
  ),
  fuchsia(
    light: AppAccentColors(
      solid: Color(0xFFA21CAF),
      onSolid: AppColorTokens.white,
      container: Color(0xFFFAE8FF),
      onContainer: Color(0xFF86198F),
    ),
    dark: AppAccentColors(
      solid: Color(0xFFE879F9),
      onSolid: AppColorTokens.neutral950,
      container: Color(0xFF4A044E),
      onContainer: Color(0xFFF5D0FE),
    ),
  ),
  rose(
    light: AppAccentColors(
      solid: Color(0xFFE11D48),
      onSolid: AppColorTokens.white,
      container: Color(0xFFFFE4E6),
      onContainer: Color(0xFF9F1239),
    ),
    dark: AppAccentColors(
      solid: Color(0xFFFB7185),
      onSolid: AppColorTokens.neutral950,
      container: Color(0xFF4C0519),
      onContainer: Color(0xFFFECDD3),
    ),
  ),
  red(
    light: AppAccentColors(
      solid: AppColorTokens.danger600,
      onSolid: AppColorTokens.white,
      container: AppColorTokens.danger100,
      onContainer: AppColorTokens.danger800,
    ),
    dark: AppAccentColors(
      solid: AppColorTokens.danger400,
      onSolid: AppColorTokens.neutral950,
      container: Color(0xFF450A0A),
      onContainer: Color(0xFFFECACA),
    ),
  ),
  orange(
    light: AppAccentColors(
      solid: Color(0xFFC2410C),
      onSolid: AppColorTokens.white,
      container: Color(0xFFFFEDD5),
      onContainer: Color(0xFF9A3412),
    ),
    dark: AppAccentColors(
      solid: Color(0xFFFB923C),
      onSolid: AppColorTokens.neutral950,
      container: Color(0xFF431407),
      onContainer: Color(0xFFFED7AA),
    ),
  ),
  amber(
    light: AppAccentColors(
      solid: Color(0xFFB45309),
      onSolid: AppColorTokens.white,
      container: Color(0xFFFEF3C7),
      onContainer: Color(0xFF92400E),
    ),
    dark: AppAccentColors(
      solid: Color(0xFFFBBF24),
      onSolid: AppColorTokens.neutral950,
      container: Color(0xFF451A03),
      onContainer: Color(0xFFFDE68A),
    ),
  ),
  green(
    light: AppAccentColors(
      solid: AppColorTokens.success700,
      onSolid: AppColorTokens.white,
      container: AppColorTokens.success100,
      onContainer: AppColorTokens.success800,
    ),
    dark: AppAccentColors(
      solid: AppColorTokens.success400,
      onSolid: AppColorTokens.neutral950,
      container: Color(0xFF052E16),
      onContainer: Color(0xFFBBF7D0),
    ),
  ),
  emerald(
    light: AppAccentColors(
      solid: Color(0xFF047857),
      onSolid: AppColorTokens.white,
      container: Color(0xFFD1FAE5),
      onContainer: Color(0xFF065F46),
    ),
    dark: AppAccentColors(
      solid: Color(0xFF34D399),
      onSolid: AppColorTokens.neutral950,
      container: Color(0xFF022C22),
      onContainer: Color(0xFFA7F3D0),
    ),
  ),
  teal(
    light: AppAccentColors(
      solid: Color(0xFF0F766E),
      onSolid: AppColorTokens.white,
      container: Color(0xFFCCFBF1),
      onContainer: Color(0xFF115E59),
    ),
    dark: AppAccentColors(
      solid: Color(0xFF2DD4BF),
      onSolid: AppColorTokens.neutral950,
      container: Color(0xFF042F2E),
      onContainer: Color(0xFF99F6E4),
    ),
  ),
  cyan(
    light: AppAccentColors(
      solid: Color(0xFF0E7490),
      onSolid: AppColorTokens.white,
      container: Color(0xFFCFFAFE),
      onContainer: Color(0xFF155E75),
    ),
    dark: AppAccentColors(
      solid: Color(0xFF22D3EE),
      onSolid: AppColorTokens.neutral950,
      container: Color(0xFF083344),
      onContainer: Color(0xFFA5F3FC),
    ),
  ),
  slate(
    light: AppAccentColors(
      solid: AppColorTokens.neutral600,
      onSolid: AppColorTokens.white,
      container: AppColorTokens.neutral100,
      onContainer: AppColorTokens.neutral700,
    ),
    dark: AppAccentColors(
      solid: AppColorTokens.neutral400,
      onSolid: AppColorTokens.neutral950,
      container: AppColorTokens.neutral800,
      onContainer: AppColorTokens.neutral200,
    ),
  );

  const AppAccent({required this.light, required this.dark});

  final AppAccentColors light;
  final AppAccentColors dark;

  AppAccentColors resolve(Brightness brightness) =>
      brightness == Brightness.dark ? dark : light;

  /// The hues subjects and classes are coloured from: everything except [red], [green] and
  /// [slate], which stay reserved for danger, success and neutral states so a subject never reads
  /// as a status.
  static const List<AppAccent> subjectHues = [
    blue,
    violet,
    emerald,
    amber,
    rose,
    cyan,
    indigo,
    orange,
    teal,
    fuchsia,
  ];
}
