import 'package:flutter/material.dart';

import '../tokens/app_color_tokens.dart';

/// Corporate Precision — [ColorScheme] mapping.
///
/// Built field-by-field from [AppColorTokens] instead of [ColorScheme.fromSeed], because a
/// seeded scheme derives its palette algorithmically and will not reproduce the token spec's
/// exact hex values. Mirrors the semantic aliases in `packages/ui/src/theme.ts`
/// (`semanticColor`) — see that file for the light/dark pairing this follows.
abstract final class AppColorScheme {
  static const light = ColorScheme(
    brightness: Brightness.light,

    primary: AppColorTokens.accent600,
    onPrimary: AppColorTokens.white,
    primaryContainer: AppColorTokens.accent100,
    onPrimaryContainer: AppColorTokens.accent800,

    secondary: AppColorTokens.neutral700,
    onSecondary: AppColorTokens.white,
    secondaryContainer: AppColorTokens.neutral100,
    onSecondaryContainer: AppColorTokens.neutral800,

    tertiary: AppColorTokens.success700,
    onTertiary: AppColorTokens.white,
    tertiaryContainer: AppColorTokens.success100,
    onTertiaryContainer: AppColorTokens.success800,

    error: AppColorTokens.danger600,
    onError: AppColorTokens.white,
    errorContainer: AppColorTokens.danger100,
    onErrorContainer: AppColorTokens.danger800,

    // `surface` and `surfaceContainerHighest` carry the token spec's `background` and
    // `surface` aliases respectively — the web tokens use "surface" for the subtler of the
    // two, which Material3 calls `surfaceContainerHighest`.
    surface: AppColorTokens.white,
    onSurface: AppColorTokens.neutral900,
    surfaceContainerHighest: AppColorTokens.neutral50,
    onSurfaceVariant: AppColorTokens.neutral600,

    outline: AppColorTokens.neutral200,
    outlineVariant: AppColorTokens.neutral200,

    shadow: AppColorTokens.black,
    scrim: AppColorTokens.black,

    inverseSurface: AppColorTokens.neutral900,
    onInverseSurface: AppColorTokens.neutral50,
    inversePrimary: AppColorTokens.accent400,
    surfaceTint: AppColorTokens.accent600,
  );

  static const dark = ColorScheme(
    brightness: Brightness.dark,

    primary: AppColorTokens.accent400,
    onPrimary: AppColorTokens.neutral950,
    primaryContainer: AppColorTokens.neutral900,
    onPrimaryContainer: AppColorTokens.accent400,

    secondary: AppColorTokens.neutral300,
    onSecondary: AppColorTokens.neutral950,
    secondaryContainer: AppColorTokens.neutral800,
    onSecondaryContainer: AppColorTokens.neutral100,

    tertiary: AppColorTokens.success400,
    onTertiary: AppColorTokens.neutral950,
    tertiaryContainer: AppColorTokens.neutral900,
    onTertiaryContainer: AppColorTokens.success400,

    error: AppColorTokens.danger400,
    onError: AppColorTokens.neutral950,
    errorContainer: AppColorTokens.neutral900,
    onErrorContainer: AppColorTokens.danger400,

    surface: AppColorTokens.neutral950,
    onSurface: AppColorTokens.neutral50,
    surfaceContainerHighest: AppColorTokens.neutral900,
    onSurfaceVariant: AppColorTokens.neutral400,

    outline: AppColorTokens.neutral700,
    outlineVariant: AppColorTokens.neutral700,

    shadow: AppColorTokens.black,
    scrim: AppColorTokens.black,

    inverseSurface: AppColorTokens.neutral50,
    onInverseSurface: AppColorTokens.neutral900,
    inversePrimary: AppColorTokens.accent600,
    surfaceTint: AppColorTokens.accent400,
  );
}
