import 'package:flutter/material.dart';

import '../colors/app_colors.dart';
import '../typography/app_typography.dart';

abstract final class AppTheme {
  static ThemeData get light {
    final colorScheme = ColorScheme.fromSeed(
      seedColor: AppColors.brand,
      brightness: Brightness.light,
    );

    return ThemeData(
      colorScheme: colorScheme,
      textTheme: AppTypography.textTheme,
      useMaterial3: true,
    );
  }

  static ThemeData get dark {
    final colorScheme = ColorScheme.fromSeed(
      seedColor: AppColors.brandDark,
      brightness: Brightness.dark,
    );

    return ThemeData(
      colorScheme: colorScheme,
      textTheme: AppTypography.textTheme,
      useMaterial3: true,
    );
  }
}
