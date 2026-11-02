import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import '../tokens/app_typography_tokens.dart';

/// Corporate Precision — Inter type scale, mapped onto Material3's [TextTheme] roles.
///
/// The token spec (`packages/ui/src/theme.ts`) defines 9 sizes; Material3's [TextTheme] has
/// 13 roles, so adjacent roles intentionally share a size step, differentiated by weight. See
/// the mapping table in `../README.md`.
///
/// Colors are deliberately left unset: [ThemeData] merges this on top of the default
/// Material3 typography derived from [ColorScheme] (`textTheme = defaultTextTheme.merge(...)`
/// in `theme_data.dart`), and in that merge the default's color survives wherever ours is
/// null. Setting a color here would fight that and break dark mode.
abstract final class AppTypography {
  /// Bundled Arabic family (`pubspec.yaml` `fonts:`). Inter ships no Arabic glyphs, so every
  /// role falls back to this per glyph: Latin text and digits stay in Inter, Arabic script renders
  /// in IBM Plex Sans Arabic instead of whatever system font the platform would pick.
  static const arabicFontFamily = 'IBMPlexSansArabic';

  static TextTheme get textTheme {
    // `GoogleFonts.interTextTheme` overwrites each style's `fontFamilyFallback`, so the Arabic
    // fallback is appended afterwards rather than set on the const styles below.
    return _withArabicFallback(_interTextTheme);
  }

  static TextTheme _withArabicFallback(TextTheme theme) {
    TextStyle? add(TextStyle? style) =>
        style?.copyWith(fontFamilyFallback: [...?style.fontFamilyFallback, arabicFontFamily]);
    return theme.copyWith(
      displayLarge: add(theme.displayLarge),
      displayMedium: add(theme.displayMedium),
      displaySmall: add(theme.displaySmall),
      headlineLarge: add(theme.headlineLarge),
      headlineMedium: add(theme.headlineMedium),
      headlineSmall: add(theme.headlineSmall),
      titleLarge: add(theme.titleLarge),
      titleMedium: add(theme.titleMedium),
      titleSmall: add(theme.titleSmall),
      bodyLarge: add(theme.bodyLarge),
      bodyMedium: add(theme.bodyMedium),
      bodySmall: add(theme.bodySmall),
      labelLarge: add(theme.labelLarge),
      labelMedium: add(theme.labelMedium),
      labelSmall: add(theme.labelSmall),
    );
  }

  static TextTheme get _interTextTheme {
    return GoogleFonts.interTextTheme(
      const TextTheme(
        displayLarge: _display5xl,
        displayMedium: _display4xl,
        displaySmall: _display3xl,
        headlineLarge: _headline4xl,
        headlineMedium: _headline3xl,
        headlineSmall: _headline2xl,
        titleLarge: _titleXl,
        titleMedium: _titleLg,
        titleSmall: _titleBase,
        bodyLarge: _bodyBase,
        bodyMedium: _bodySm,
        bodySmall: _bodyXs,
        labelLarge: _labelSm,
        labelMedium: _labelXs,
        labelSmall: _labelXs,
      ),
    );
  }

  static const _display5xl = TextStyle(
    fontSize: AppFontSize.xl5,
    height: AppLineHeight.xl5 / AppFontSize.xl5,
    fontWeight: AppFontWeight.bold,
    letterSpacing: AppTracking.tight * AppFontSize.xl5,
  );

  static const _display4xl = TextStyle(
    fontSize: AppFontSize.xl4,
    height: AppLineHeight.xl4 / AppFontSize.xl4,
    fontWeight: AppFontWeight.bold,
    letterSpacing: AppTracking.tight * AppFontSize.xl4,
  );

  static const _display3xl = TextStyle(
    fontSize: AppFontSize.xl3,
    height: AppLineHeight.xl3 / AppFontSize.xl3,
    fontWeight: AppFontWeight.bold,
    letterSpacing: AppTracking.tight * AppFontSize.xl3,
  );

  static const _headline4xl = TextStyle(
    fontSize: AppFontSize.xl4,
    height: AppLineHeight.xl4 / AppFontSize.xl4,
    fontWeight: AppFontWeight.semibold,
    letterSpacing: AppTracking.tight * AppFontSize.xl4,
  );

  static const _headline3xl = TextStyle(
    fontSize: AppFontSize.xl3,
    height: AppLineHeight.xl3 / AppFontSize.xl3,
    fontWeight: AppFontWeight.semibold,
    letterSpacing: AppTracking.tight * AppFontSize.xl3,
  );

  static const _headline2xl = TextStyle(
    fontSize: AppFontSize.xl2,
    height: AppLineHeight.xl2 / AppFontSize.xl2,
    fontWeight: AppFontWeight.semibold,
    letterSpacing: AppTracking.snug * AppFontSize.xl2,
  );

  static const _titleXl = TextStyle(
    fontSize: AppFontSize.xl,
    height: AppLineHeight.xl / AppFontSize.xl,
    fontWeight: AppFontWeight.semibold,
    letterSpacing: AppTracking.snug * AppFontSize.xl,
  );

  static const _titleLg = TextStyle(
    fontSize: AppFontSize.lg,
    height: AppLineHeight.lg / AppFontSize.lg,
    fontWeight: AppFontWeight.semibold,
    letterSpacing: AppTracking.normal,
  );

  static const _titleBase = TextStyle(
    fontSize: AppFontSize.base,
    height: AppLineHeight.base / AppFontSize.base,
    fontWeight: AppFontWeight.semibold,
    letterSpacing: AppTracking.normal,
  );

  static const _bodyBase = TextStyle(
    fontSize: AppFontSize.base,
    height: AppLineHeight.base / AppFontSize.base,
    fontWeight: AppFontWeight.regular,
    letterSpacing: AppTracking.normal,
  );

  static const _bodySm = TextStyle(
    fontSize: AppFontSize.sm,
    height: AppLineHeight.sm / AppFontSize.sm,
    fontWeight: AppFontWeight.regular,
    letterSpacing: AppTracking.normal,
  );

  static const _bodyXs = TextStyle(
    fontSize: AppFontSize.xs,
    height: AppLineHeight.xs / AppFontSize.xs,
    fontWeight: AppFontWeight.regular,
    letterSpacing: AppTracking.normal,
  );

  static const _labelSm = TextStyle(
    fontSize: AppFontSize.sm,
    height: AppLineHeight.sm / AppFontSize.sm,
    fontWeight: AppFontWeight.medium,
    letterSpacing: AppTracking.normal,
  );

  static const _labelXs = TextStyle(
    fontSize: AppFontSize.xs,
    height: AppLineHeight.xs / AppFontSize.xs,
    fontWeight: AppFontWeight.medium,
    letterSpacing: AppTracking.normal,
  );
}
