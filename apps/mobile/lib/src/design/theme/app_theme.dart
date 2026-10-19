import 'package:flutter/material.dart';

import '../typography/app_typography.dart';
import 'app_color_scheme.dart';
import 'app_semantic_colors.dart';
import 'component_themes/app_button_theme.dart';
import 'component_themes/app_card_theme.dart';
import 'component_themes/app_chip_theme.dart';
import 'component_themes/app_chrome_theme.dart';
import 'component_themes/app_input_theme.dart';

/// Corporate Precision — Flutter [ThemeData].
///
/// Assembles the color scheme, type scale, and component themes defined elsewhere in
/// `design/` into the two themes [StudafyApp] hands to [MaterialApp.router]. See
/// `design/README.md` for how each piece maps back to the token spec.
abstract final class AppTheme {
  static ThemeData get light => _build(AppColorScheme.light, AppSemanticColors.light());

  static ThemeData get dark => _build(AppColorScheme.dark, AppSemanticColors.dark());

  static ThemeData _build(ColorScheme colors, AppSemanticColors semanticColors) {
    final textTheme = AppTypography.textTheme;

    return ThemeData(
      useMaterial3: true,
      colorScheme: colors,
      textTheme: textTheme,
      // The web's `surface` token: pages sit on it and cards (`background`) lift off it, the
      // same pairing as the portal's sidebar and content panes.
      scaffoldBackgroundColor: colors.surfaceContainerHighest,
      extensions: [semanticColors],
      filledButtonTheme: AppButtonTheme.filled(colors),
      outlinedButtonTheme: AppButtonTheme.outlined(colors),
      textButtonTheme: AppButtonTheme.text(colors),
      inputDecorationTheme: AppInputTheme.build(colors),
      cardTheme: AppCardTheme.build(colors),
      chipTheme: AppChipTheme.build(colors, textTheme),
      appBarTheme: AppChromeTheme.appBar(colors, textTheme),
      navigationBarTheme: AppChromeTheme.navigationBar(colors, textTheme),
      dialogTheme: AppChromeTheme.dialog(colors, textTheme),
      bottomSheetTheme: AppChromeTheme.bottomSheet(colors),
      popupMenuTheme: AppChromeTheme.popupMenu(colors, textTheme),
      snackBarTheme: AppChromeTheme.snackBar(colors, textTheme),
      listTileTheme: AppChromeTheme.listTile(colors, textTheme),
      dividerTheme: AppChromeTheme.divider(colors),
      floatingActionButtonTheme: AppChromeTheme.fab(colors),
      segmentedButtonTheme: AppChromeTheme.segmentedButton(colors),
      progressIndicatorTheme: AppChromeTheme.progressIndicator(colors),
    );
  }
}
