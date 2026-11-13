import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_color_scheme.dart';
import 'package:studafy_mobile/src/design/theme/app_semantic_colors.dart';

void main() {
  group('AppColorScheme.light matches the token spec hex values exactly', () {
    // Expected values copied from packages/ui/src/theme.ts (semanticColor.light), not derived
    // from AppColorScheme itself — this test exists to catch drift between the two.
    test('primary (accent)', () {
      expect(AppColorScheme.light.primary, const Color(0xFF2563EB));
      expect(AppColorScheme.light.onPrimary, const Color(0xFFFFFFFF));
      expect(AppColorScheme.light.primaryContainer, const Color(0xFFDBEAFE));
      expect(AppColorScheme.light.onPrimaryContainer, const Color(0xFF1E40AF));
    });

    test('surface (background/surface aliases)', () {
      expect(AppColorScheme.light.surface, const Color(0xFFFFFFFF));
      expect(AppColorScheme.light.onSurface, const Color(0xFF0F172A));
      expect(AppColorScheme.light.surfaceContainerHighest, const Color(0xFFF8FAFC));
      expect(AppColorScheme.light.onSurfaceVariant, const Color(0xFF475569));
      expect(AppColorScheme.light.outline, const Color(0xFFE2E8F0));
    });

    test('tertiary (success)', () {
      expect(AppColorScheme.light.tertiary, const Color(0xFF15803D));
      expect(AppColorScheme.light.onTertiary, const Color(0xFFFFFFFF));
      expect(AppColorScheme.light.tertiaryContainer, const Color(0xFFDCFCE7));
      expect(AppColorScheme.light.onTertiaryContainer, const Color(0xFF166534));
    });

    test('error (danger)', () {
      expect(AppColorScheme.light.error, const Color(0xFFDC2626));
      expect(AppColorScheme.light.onError, const Color(0xFFFFFFFF));
      expect(AppColorScheme.light.errorContainer, const Color(0xFFFEE2E2));
      expect(AppColorScheme.light.onErrorContainer, const Color(0xFF991B1B));
    });

    test('warning (AppSemanticColors — no ColorScheme role for this one)', () {
      final warning = AppSemanticColors.light();
      expect(warning.warning, const Color(0xFFA16207));
      expect(warning.onWarning, const Color(0xFFFFFFFF));
      expect(warning.warningContainer, const Color(0xFFFEF9C3));
      expect(warning.onWarningContainer, const Color(0xFF854D0E));
    });
  });

  group('AppColorScheme.dark matches the token spec hex values exactly', () {
    test('primary (accent)', () {
      expect(AppColorScheme.dark.primary, const Color(0xFF60A5FA));
      expect(AppColorScheme.dark.onPrimary, const Color(0xFF020617));
      expect(AppColorScheme.dark.primaryContainer, const Color(0xFF0F172A));
      expect(AppColorScheme.dark.onPrimaryContainer, const Color(0xFF60A5FA));
    });

    test('surface (background/surface aliases)', () {
      expect(AppColorScheme.dark.surface, const Color(0xFF020617));
      expect(AppColorScheme.dark.onSurface, const Color(0xFFF8FAFC));
      expect(AppColorScheme.dark.surfaceContainerHighest, const Color(0xFF0F172A));
      expect(AppColorScheme.dark.onSurfaceVariant, const Color(0xFF94A3B8));
      expect(AppColorScheme.dark.outline, const Color(0xFF334155));
    });

    test('warning (AppSemanticColors — no ColorScheme role for this one)', () {
      final warning = AppSemanticColors.dark();
      expect(warning.warning, const Color(0xFFFACC15));
      expect(warning.onWarning, const Color(0xFF020617));
      expect(warning.warningContainer, const Color(0xFF0F172A));
      expect(warning.onWarningContainer, const Color(0xFFFACC15));
    });
  });

  test('AppSemanticColors.lerp interpolates every field, not just a passthrough', () {
    final light = AppSemanticColors.light();
    final dark = AppSemanticColors.dark();

    final midpoint = light.lerp(dark, 0.5);

    expect(midpoint.warning, Color.lerp(light.warning, dark.warning, 0.5));
    expect(midpoint.onWarning, Color.lerp(light.onWarning, dark.onWarning, 0.5));
  });
}
