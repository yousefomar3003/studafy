import 'package:flutter/material.dart';

abstract final class AppTypography {
  static const textTheme = TextTheme(
    headlineSmall: TextStyle(fontWeight: FontWeight.w700),
    titleMedium: TextStyle(fontWeight: FontWeight.w600),
    bodyMedium: TextStyle(height: 1.5),
  );
}
