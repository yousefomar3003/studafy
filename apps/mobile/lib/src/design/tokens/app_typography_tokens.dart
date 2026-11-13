import 'package:flutter/painting.dart';

/// Corporate Precision — Inter type scale.
///
/// Canonical source: `packages/ui/src/theme.ts` (`font`). Sizes and line heights are in
/// logical pixels (the web tokens use rem at a 16px root, so `1rem == 16px` here).
abstract final class AppFontSize {
  static const double xs = 12;
  static const double sm = 14;
  static const double base = 16;
  static const double lg = 18;
  static const double xl = 20;
  static const double xl2 = 24;
  static const double xl3 = 30;
  static const double xl4 = 36;
  static const double xl5 = 48;
}

/// Line heights in logical pixels, paired 1:1 with [AppFontSize]. Convert to Flutter's
/// [TextStyle.height] (a multiplier of font size) via `lineHeight / fontSize` — never assign
/// these directly as `height`.
abstract final class AppLineHeight {
  static const double xs = 16;
  static const double sm = 20;
  static const double base = 24;
  static const double lg = 28;
  static const double xl = 28;
  static const double xl2 = 32;
  static const double xl3 = 36;
  static const double xl4 = 40;
  static const double xl5 = 48;
}

abstract final class AppFontWeight {
  static const FontWeight regular = FontWeight.w400;
  static const FontWeight medium = FontWeight.w500;
  static const FontWeight semibold = FontWeight.w600;
  static const FontWeight bold = FontWeight.w700;
}

/// Letter spacing, in em. Multiply by a style's font size to get logical-pixel
/// `letterSpacing`, matching the CSS `em` unit the web tokens use.
abstract final class AppTracking {
  static const double tight = -0.02;
  static const double snug = -0.01;
  static const double normal = 0;
}
